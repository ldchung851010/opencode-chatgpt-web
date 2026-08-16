import assert from "node:assert/strict";
import test from "node:test";
import { currentToolResults } from "../src/adapters/chatgpt-web/opencode-integration.ts";
import { TurnCorrelationRegistry } from "../src/adapters/chatgpt-web/turn-correlation.ts";

type ToolRequest = { callId: string; name: string; arguments: Record<string, unknown> };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

class FakeBrowserTurn {
  readonly browserNumber: number;
  readonly requestReady = deferred<ToolRequest>();
  readonly resultReady = deferred<unknown>();
  readonly final: Promise<string>;
  outstanding?: ToolRequest;
  constructor(browserNumber: number) { this.browserNumber = browserNumber; this.final = this.run(); }
  private async run(): Promise<string> {
    const request = { callId: "call_read_vertical_slice", name: "read", arguments: { filePath: "README.md" } };
    this.outstanding = request; this.requestReady.resolve(request);
    const result = await this.resultReady.promise; this.outstanding = undefined;
    return `Browser ${this.browserNumber} continued with: ${String(result)}`;
  }
  completeTool(result: unknown): void { this.resultReady.resolve(result); }
}
function user(text: string) { return { role: "user", content: [{ type: "input_text", text }] }; }
function initialRequest() { return { model: "gpt-5.6-sol", input: [user("Read README.md and tell me the first line")], tools: [{ type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } }] }; }

test("vertical slice keeps one browser response alive across function_call_output", async () => {
  let browserStarts = 0; let readExecutions = 0; const correlations = new TurnCorrelationRegistry<FakeBrowserTurn>();
  const r0 = initialRequest();
  const route0 = correlations.resolve({ clientSessionId: "opencode-session-1", rawRequest: r0, currentCallIds: [], start: () => new FakeBrowserTurn(++browserStarts) });
  const toolCall = await route0.session.requestReady.promise;
  correlations.bindCalls(route0.sessionId, "opencode-session-1", [toolCall.callId]);
  assert.equal(browserStarts, 1); readExecutions += 1; const localReadResult = "# codex-chatgpt-web";
  const r1 = { ...r0, input: [...r0.input, { type: "function_call", call_id: toolCall.callId, name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) }, { type: "function_call_output", call_id: toolCall.callId, output: localReadResult }] };
  const results = currentToolResults(r1);
  const route1 = correlations.resolve({ clientSessionId: "opencode-session-1", rawRequest: r1, currentCallIds: results.map(result => result.callId), start: () => new FakeBrowserTurn(++browserStarts) });
  assert.equal(route1.kind, "tool-continuation"); assert.equal(route1.sessionId, route0.sessionId); assert.equal(route1.session, route0.session); assert.equal(browserStarts, 1);
  route1.session.completeTool(results[0]!.output); correlations.markDelivered(route1.sessionId, "opencode-session-1", toolCall.callId);
  const answer = await route1.session.final; correlations.settleSession(route1.sessionId, "opencode-session-1");
  assert.equal(answer, "Browser 1 continued with: # codex-chatgpt-web"); assert.equal(browserStarts, 1); assert.equal(readExecutions, 1);
});

test("retry of R0 replays the same pending function call without duplicate browser/tool execution", async () => {
  let browserStarts = 0; const correlations = new TurnCorrelationRegistry<FakeBrowserTurn>(); const r0 = initialRequest();
  const first = correlations.resolve({ clientSessionId: "opencode-session-1", rawRequest: r0, currentCallIds: [], start: () => new FakeBrowserTurn(++browserStarts) });
  const toolCall = await first.session.requestReady.promise; correlations.bindCalls(first.sessionId, "opencode-session-1", [toolCall.callId]);
  const retry = correlations.resolve({ clientSessionId: "opencode-session-1", rawRequest: r0, currentCallIds: [], start: () => new FakeBrowserTurn(++browserStarts) });
  assert.equal(retry.kind, "request-retry"); assert.equal(retry.sessionId, first.sessionId); assert.equal(retry.session.outstanding?.callId, toolCall.callId); assert.equal(browserStarts, 1);
});
