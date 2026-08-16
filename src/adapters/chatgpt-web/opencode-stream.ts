import type { AdapterEvent, CodexUsage } from "../../types";
import type { BrokerToolRequest } from "./turn-broker.ts";
import type { ChatGptTraceEvent } from "./turn-execution.ts";

export function emitOpenCodeTraceEvents(
  trace: ChatGptTraceEvent[],
  emit: (event: AdapterEvent) => void,
): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") emit({ type: "text_delta", text: event.text, phase: "commentary" });
    else emit({ type: "thinking_delta", thinking: event.text });
  }
}

export function emitOpenCodeTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

export function emitOpenCodeToolBatch(
  requests: BrokerToolRequest[],
  emit: (event: AdapterEvent) => void,
  usage?: CodexUsage,
): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.name });
    emit({ type: "tool_call_delta", arguments: JSON.stringify(request.arguments ?? {}) });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, ...(usage ? { usage } : {}) });
}

export function emitOpenCodeDone(emit: (event: AdapterEvent) => void, usage?: CodexUsage): void {
  emit({ type: "done", stopReason: "stop", endTurn: true, ...(usage ? { usage } : {}) });
}
