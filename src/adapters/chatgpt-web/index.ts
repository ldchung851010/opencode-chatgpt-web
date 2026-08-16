import { defaultBrokerEndpoint, resolveBrokerEndpoint } from "../../config";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import type { ProviderAdapter } from "../base";
import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { runOpenCodeAdapterTurn } from "./opencode-adapter-loop.ts";
import { compileOpenCodeWebPrompt, openCodeReadOnlyContextWarning } from "./opencode-prompt.ts";
import { sharedOpenCodeTurnController } from "./opencode-turn-controller.ts";
import type { OpenCodeTurnEnvironment } from "./tool-environment.ts";
import { TurnBroker } from "./turn-broker.ts";
import { ChatGptTextFeed, ChatGptTraceFeed, type ChatGptTurnRuntime } from "./turn-execution.ts";

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function rawResponsesRequest(parsed: CodexParsedRequest): unknown {
  if (!parsed._rawBody || typeof parsed._rawBody !== "object") {
    throw new Error("OpenCode ChatGPT Web adapter requires the original Responses request body");
  }
  return parsed._rawBody;
}

function rejectImpossibleReadOnlyToolChoice(environment: OpenCodeTurnEnvironment, displayLabel: string): void {
  if (environment.toolPolicy.mode === "required" || environment.toolPolicy.mode === "specific") {
    throw new Error(
      `tool_choice=${environment.toolPolicy.mode} requires an OpenCode local tool, but ChatGPT Web ${displayLabel} does not attach the local-tool bridge`,
    );
  }
}

/**
 * OpenCode port of the ChatGPT Web adapter.
 *
 * The existing parser/model/browser/Responses event pipeline is retained. Only turn identity and
 * local-tool authority move to OpenCode-native inputs: raw Responses body + X-Session-Id + call_id.
 */
export function createChatGptWebAdapter(provider: CodexProviderConfig): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = TurnBroker.forSocket(brokerSocketPath(provider));
  const controller = sharedOpenCodeTurnController({ broker });
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const browserTtlMs = provider.chatgptWeb?.turnTimeoutMs ?? 30 * 60_000;

  const startRuntime = (
    parsed: CodexParsedRequest,
    rawRequest: unknown,
    environment: OpenCodeTurnEnvironment,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
  ): ChatGptTurnRuntime => {
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const browserAbort = new AbortController();
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();

    if (!mode.localTools) {
      rejectImpossibleReadOnlyToolChoice(environment, mode.displayLabel);
      const browser = worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileOpenCodeWebPrompt(rawRequest, {
            localTools: false,
            displayLabel: mode.displayLabel,
          }),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        onReasoningSummary: (value: string, continuation?: boolean) => trace.push({
          kind: "reasoning",
          text: value,
          ...(continuation ? { continuation: true } : {}),
        }),
        onCommentary: (value: string, continuation?: boolean) => trace.push({
          kind: "commentary",
          text: value,
          ...(continuation ? { continuation: true } : {}),
        }),
        onTextDelta: (delta: string) => text.push(delta),
      });
      return {
        mode: "read-only",
        browser,
        trace,
        text,
        cancel: () => browserAbort.abort(),
      };
    }

    const token = deferred<string>();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: async () => {
        const turnToken = await broker.register(
          environment,
          browserTtlMs + 60_000,
          traceId,
        );
        activeToken = turnToken;
        tokenSettled = true;
        token.resolve(turnToken);
        try {
          return {
            ...compileOpenCodeWebPrompt(rawRequest, {
              localTools: true,
              displayLabel: mode.displayLabel,
              turnToken,
            }),
            release: () => {},
          };
        } catch (error) {
          broker.revoke(turnToken);
          throw error;
        }
      },
      abortSignal: browserAbort.signal,
      onReasoningSummary: (value: string, continuation?: boolean) => trace.push({
        kind: "reasoning",
        text: value,
        ...(continuation ? { continuation: true } : {}),
      }),
      onCommentary: (value: string, continuation?: boolean) => trace.push({
        kind: "commentary",
        text: value,
        ...(continuation ? { continuation: true } : {}),
      }),
      onTextDelta: (delta: string) => text.push(delta),
    });
    void browser.catch(error => {
      if (tokenSettled) return;
      tokenSettled = true;
      token.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return {
      mode: "tools",
      token: token.promise,
      browser,
      trace,
      text,
      cancel: () => {
        browserAbort.abort();
        if (activeToken) broker.revoke(activeToken);
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const rawRequest = rawResponsesRequest(parsed);
      if (parsed._compactionRequest) {
        throw new Error("OpenCode ChatGPT Web does not use the Codex compaction transport envelope");
      }
      if (parsed._opaqueMultiAgentV2Payload) {
        throw new Error("OpenCode subagents must arrive as ordinary OpenCode task tool calls, not Codex MultiAgent encrypted payloads");
      }

      const turnCapabilities = configuredCapabilities;
      const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        if (!mode.localTools) {
          const warning = openCodeReadOnlyContextWarning(rawRequest, mode.displayLabel);
          if (warning) {
            emit({ type: "assistant_boundary" });
            emit({ type: "text_delta", text: warning, phase: "commentary" });
            emit({ type: "assistant_boundary" });
          }
        }
        await runOpenCodeAdapterTurn({
          controller,
          rawRequest,
          headers: incoming.headers,
          ...(incoming.abortSignal ? { abortSignal: incoming.abortSignal } : {}),
          emit,
          startRuntime: (environment, traceId) => startRuntime(
            parsed,
            rawRequest,
            environment,
            traceId,
            turnCapabilities,
          ),
        });
      } catch (error) {
        if (error instanceof ChatGptWebAdapterError) {
          emit({
            type: "error",
            message: error.message,
            status: error.status,
            errorType: error.errorType,
            code: error.code,
            retryable: error.retryable,
          });
          return;
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
