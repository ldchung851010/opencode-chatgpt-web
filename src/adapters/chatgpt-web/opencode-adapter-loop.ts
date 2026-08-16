import type { AdapterEvent, CodexUsage } from "../../types";
import type { HeaderBag } from "./opencode-integration.ts";
import { emitOpenCodeDone, emitOpenCodeToolBatch } from "./opencode-stream.ts";
import {
  OpenCodeTurnController,
  type OpenCodeTurnBoundary,
} from "./opencode-turn-controller.ts";
import type { OpenCodeTurnEnvironment } from "./tool-environment.ts";
import type { ChatGptTurnRuntime } from "./turn-execution.ts";

export interface RunOpenCodeAdapterTurnInput {
  controller: OpenCodeTurnController;
  rawRequest: unknown;
  headers: HeaderBag;
  abortSignal?: AbortSignal;
  emit: (event: AdapterEvent) => void;
  startRuntime: (environment: OpenCodeTurnEnvironment, traceId: string) => ChatGptTurnRuntime;
  usage?: (boundary: OpenCodeTurnBoundary) => CodexUsage | undefined;
}

/**
 * Adapter-facing wrapper: the controller owns browser/correlation state while this layer maps the
 * HTTP boundary to the existing generic AdapterEvent stream consumed by the Responses bridge.
 */
export async function runOpenCodeAdapterTurn(input: RunOpenCodeAdapterTurnInput): Promise<OpenCodeTurnBoundary> {
  input.emit({ type: "heartbeat" });
  const boundary = await input.controller.run({
    rawRequest: input.rawRequest,
    headers: input.headers,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    emit: input.emit,
    startRuntime: input.startRuntime,
  });
  const usage = input.usage?.(boundary);
  if (boundary.type === "tools") emitOpenCodeToolBatch(boundary.calls, input.emit, usage);
  else emitOpenCodeDone(input.emit, usage);
  return boundary;
}
