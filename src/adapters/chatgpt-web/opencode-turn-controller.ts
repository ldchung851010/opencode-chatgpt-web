import { createHash } from "node:crypto";
import type { AdapterEvent } from "../../types";
import {
  brokerResultFromFunctionCallOutput,
  currentToolResults,
  openCodeParentSession,
  requireOpenCodeSession,
  requestFingerprint,
  type HeaderBag,
} from "./opencode-integration.ts";
import { emitOpenCodeTextDeltas, emitOpenCodeTraceEvents } from "./opencode-stream.ts";
import { environmentFromResponsesRequest } from "./tool-environment.ts";
import { TurnCorrelationRegistry } from "./turn-correlation.ts";
import { TurnBroker, type BrokerToolRequest } from "./turn-broker.ts";
import { ChatGptTurnSession, type ChatGptTraceEvent, type ChatGptTurnRuntime } from "./turn-execution.ts";

export type OpenCodeTurnBoundary =
  | { type: "tools"; calls: BrokerToolRequest[]; replay: boolean }
  | { type: "final"; answer: string; replay: boolean };

export interface OpenCodeTurnControllerOptions {
  broker: TurnBroker;
  correlations?: TurnCorrelationRegistry<ChatGptTurnSession>;
}

export interface RunOpenCodeTurnInput {
  rawRequest: unknown;
  headers: HeaderBag;
  abortSignal?: AbortSignal;
  emit?: (event: AdapterEvent) => void;
  startRuntime: (environment: ReturnType<typeof environmentFromResponsesRequest>, traceId: string) => ChatGptTurnRuntime;
}

const sharedControllers = new Map<string, OpenCodeTurnController>();

export function sharedOpenCodeTurnController(options: OpenCodeTurnControllerOptions): OpenCodeTurnController {
  const key = options.broker.socketPath;
  const existing = sharedControllers.get(key);
  if (existing) return existing;
  const controller = new OpenCodeTurnController(options);
  sharedControllers.set(key, controller);
  return controller;
}

export function activeOpenCodeBrowserTurns(): number {
  let total = 0;
  for (const controller of sharedControllers.values()) total += controller.activeCount();
  return total;
}

export function cancelOpenCodeBrowserTurns(reason = "admin cancel"): number {
  let cancelled = 0;
  for (const controller of sharedControllers.values()) cancelled += controller.cancelAll(reason);
  return cancelled;
}

export function clearSharedOpenCodeTurnControllers(): void {
  cancelOpenCodeBrowserTurns("controller registry cleared");
  sharedControllers.clear();
}

function abortError(): DOMException {
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function traceId(sessionId: string, rawRequest: unknown): string {
  return createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(requestFingerprint(sessionId, rawRequest))
    .digest("hex")
    .slice(0, 12);
}

function replayEvents(events: AdapterEvent[], emit?: (event: AdapterEvent) => void): void {
  if (!emit) return;
  for (const event of events) emit(event);
}

export class OpenCodeTurnController {
  readonly correlations: TurnCorrelationRegistry<ChatGptTurnSession>;
  private readonly broker: TurnBroker;

  constructor(options: OpenCodeTurnControllerOptions) {
    this.broker = options.broker;
    this.correlations = options.correlations ?? new TurnCorrelationRegistry<ChatGptTurnSession>({
      onRetire: session => session.cancel(),
    });
  }

  activeCount(): number {
    return this.correlations.counts().activeSessions;
  }

  cancelAll(reason = "controller cancelled"): number {
    const sessions = this.correlations.clear(reason);
    for (const session of sessions) {
      session.cancel();
      if (session.runtime.mode === "tools") {
        void session.runtime.token.then(token => this.broker.revoke(token)).catch(() => {});
      }
    }
    return sessions.length;
  }

  async run(input: RunOpenCodeTurnInput): Promise<OpenCodeTurnBoundary> {
    const clientSessionId = requireOpenCodeSession(input.headers);
    const parentSessionId = openCodeParentSession(input.headers);
    const environment = environmentFromResponsesRequest(input.rawRequest, clientSessionId, parentSessionId);
    const results = currentToolResults(input.rawRequest);

    const route = this.correlations.resolve({
      clientSessionId,
      rawRequest: input.rawRequest,
      currentCallIds: results.map(result => result.callId),
      start: () => new ChatGptTurnSession(input.startRuntime(environment, traceId(clientSessionId, input.rawRequest))),
    });
    const session = route.session;

    try {
      return await session.runExclusive(async () => {
        const settled = session.settledOutcome();
        if (settled) {
          if (settled.type === "error") throw settled.error;
          const replay = session.eventsForFinalReplay();
          if (replay.length > 0) {
            replayEvents(replay, input.emit);
          } else if (input.emit) {
            const captured: AdapterEvent[] = [];
            const emitCaptured = (event: AdapterEvent) => { captured.push(event); input.emit!(event); };
            const trace = session.runtime.trace.drain();
            emitOpenCodeTraceEvents(trace, emitCaptured);
            emitOpenCodeTextDeltas(session.runtime.text.drain(), emitCaptured);
            if (session.runtime.text.value() !== settled.answer) {
              throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
            }
            session.setFinalReasoning(trace.map(event => event.text));
            session.setFinalEvents(captured);
          }
          return { type: "final", answer: settled.answer, replay: true };
        }

        if (session.runtime.mode !== "tools") {
          return await this.waitForReadOnlyBrowser(session, route.sessionId, clientSessionId, input);
        }

        const token = await withAbort(session.runtime.token, input.abortSignal);
        this.broker.updateEnvironment(token, environment);

        const outstanding = session.outstanding();
        if (outstanding.length > 0) {
          const matching = results.filter(result => session.hasOutstanding(result.callId));
          if (matching.length === 0) {
            replayEvents(session.eventsForOutstandingReplay(), input.emit);
            return { type: "tools", calls: outstanding, replay: true };
          }
          if (matching.length !== outstanding.length) {
            throw new Error(`OpenCode returned ${matching.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
          }
          for (const result of matching) {
            this.broker.completeTool(token, result.callId, brokerResultFromFunctionCallOutput(result.output));
            session.markResultDelivered(result.callId);
            this.correlations.markDelivered(route.sessionId, clientSessionId, result.callId);
          }
        }

        return await this.waitForToolOrBrowser(session, route.sessionId, clientSessionId, token, environment, input);
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        const aborted = this.correlations.abortSession(route.sessionId, clientSessionId, "client abort");
        aborted?.cancel();
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(token => this.broker.revoke(token)).catch(() => {});
        }
      } else if (session.settledOutcome()?.type === "error") {
        const failed = this.correlations.abortSession(route.sessionId, clientSessionId, "browser failure");
        failed?.cancel();
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(token => this.broker.revoke(token)).catch(() => {});
        }
      }
      throw error;
    }
  }

  private async waitForReadOnlyBrowser(
    session: ChatGptTurnSession,
    sessionId: string,
    clientSessionId: string,
    input: RunOpenCodeTurnInput,
  ): Promise<OpenCodeTurnBoundary> {
    const toolWaitAbort = new AbortController();
    const roundReasoning: string[] = [];
    const roundEvents: AdapterEvent[] = [];
    const emitRound = (event: AdapterEvent) => { roundEvents.push(event); input.emit?.(event); };
    const emitTrace = (trace: ChatGptTraceEvent[]) => {
      roundReasoning.push(...trace.map(event => event.text));
      if (input.emit) emitOpenCodeTraceEvents(trace, emitRound);
    };
    const emitText = (deltas: string[]) => { if (input.emit) emitOpenCodeTextDeltas(deltas, emitRound); };

    emitTrace(session.runtime.trace.drain());
    emitText(session.runtime.text.drain());

    try {
      const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
      if (!input.emit) {
        const next = await withAbort(browserOutcome, input.abortSignal);
        if (next.outcome.type === "error") throw next.outcome.error;
        this.correlations.settleSession(sessionId, clientSessionId);
        return { type: "final", answer: next.outcome.answer, replay: false };
      }
      let nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
      let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
      for (;;) {
        const next = await withAbort(Promise.race([browserOutcome, nextTrace, nextText]), input.abortSignal);
        if (next.type === "trace") {
          emitTrace([next.event]);
          nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
          continue;
        }
        if (next.type === "text") {
          emitText(session.runtime.text.drain());
          nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
          continue;
        }
        emitTrace(session.runtime.trace.drain());
        emitText(session.runtime.text.drain());
        if (next.outcome.type === "error") throw next.outcome.error;
        if (session.runtime.text.value() !== next.outcome.answer) {
          throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
        }
        session.setFinalReasoning(roundReasoning);
        session.setFinalEvents(roundEvents);
        this.correlations.settleSession(sessionId, clientSessionId);
        return { type: "final", answer: next.outcome.answer, replay: false };
      }
    } finally {
      toolWaitAbort.abort();
    }
  }

  private async waitForToolOrBrowser(
    session: ChatGptTurnSession,
    sessionId: string,
    clientSessionId: string,
    token: string,
    environment: ReturnType<typeof environmentFromResponsesRequest>,
    input: RunOpenCodeTurnInput,
  ): Promise<OpenCodeTurnBoundary> {
    const toolWaitAbort = new AbortController();
    const roundReasoning: string[] = [];
    const roundEvents: AdapterEvent[] = [];
    const emitRound = (event: AdapterEvent) => { roundEvents.push(event); input.emit?.(event); };
    const emitTrace = (trace: ChatGptTraceEvent[]) => {
      roundReasoning.push(...trace.map(event => event.text));
      if (input.emit) emitOpenCodeTraceEvents(trace, emitRound);
    };
    const emitText = (deltas: string[]) => { if (input.emit) emitOpenCodeTextDeltas(deltas, emitRound); };

    emitTrace(session.runtime.trace.drain());
    emitText(session.runtime.text.drain());

    try {
      const nextTools = this.broker.nextToolBatch(token, toolWaitAbort.signal).then(calls => ({ type: "tools" as const, calls }));
      const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
      if (!input.emit) {
        const next = await withAbort(Promise.race([nextTools, browserOutcome]), input.abortSignal);
        if (next.type === "browser") {
          this.broker.revoke(token);
          if (next.outcome.type === "error") throw next.outcome.error;
          if (environment.toolPolicy.mode === "required" || environment.toolPolicy.mode === "specific") {
            throw new Error(`tool_choice=${environment.toolPolicy.mode} requires a tool call before the model can finish`);
          }
          this.correlations.settleSession(sessionId, clientSessionId);
          return { type: "final", answer: next.outcome.answer, replay: false };
        }
        if (next.calls.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
        this.correlations.bindCalls(sessionId, clientSessionId, next.calls.map(call => call.callId));
        session.setOutstanding(next.calls);
        return { type: "tools", calls: next.calls, replay: false };
      }

      let nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
      let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
      for (;;) {
        const next = await withAbort(Promise.race([nextTools, browserOutcome, nextTrace, nextText]), input.abortSignal);
        if (next.type === "trace") {
          emitTrace([next.event]);
          nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
          continue;
        }
        if (next.type === "text") {
          emitText(session.runtime.text.drain());
          nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
          continue;
        }
        emitTrace(session.runtime.trace.drain());
        emitText(session.runtime.text.drain());
        if (next.type === "browser") {
          this.broker.revoke(token);
          if (next.outcome.type === "error") throw next.outcome.error;
          if (environment.toolPolicy.mode === "required" || environment.toolPolicy.mode === "specific") {
            throw new Error(`tool_choice=${environment.toolPolicy.mode} requires a tool call before the model can finish`);
          }
          if (session.runtime.text.value() !== next.outcome.answer) {
            throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
          }
          session.setFinalReasoning(roundReasoning);
          session.setFinalEvents(roundEvents);
          this.correlations.settleSession(sessionId, clientSessionId);
          return { type: "final", answer: next.outcome.answer, replay: false };
        }
        if (next.calls.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
        this.correlations.bindCalls(sessionId, clientSessionId, next.calls.map(call => call.callId));
        session.setOutstanding(next.calls, roundReasoning, roundEvents);
        return { type: "tools", calls: next.calls, replay: false };
      }
    } finally {
      toolWaitAbort.abort();
    }
  }
}
