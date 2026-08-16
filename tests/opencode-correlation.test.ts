import assert from "node:assert/strict";
import test from "node:test";
import {
  environmentFromResponsesRequest,
  toolRevision,
  validateToolInvocation,
  ToolSchemaChangedError,
  ToolPolicyError,
  ParallelToolCallError,
} from "../src/adapters/chatgpt-web/tool-environment.ts";
import { currentToolResults, requireOpenCodeSession } from "../src/adapters/chatgpt-web/opencode-integration.ts";
import { TurnCorrelationRegistry } from "../src/adapters/chatgpt-web/turn-correlation.ts";

function user(text: string) { return { role: "user", content: [{ type: "input_text", text }] }; }
function request(input: unknown[], extra: Record<string, unknown> = {}) { return { model: "gpt-5.6-sol", input, ...extra }; }

test("extracts X-Session-Id case-insensitively", () => {
  assert.equal(requireOpenCodeSession({ "x-session-id": "session-a" }), "session-a");
  assert.throws(() => requireOpenCodeSession({}), /X-Session-Id/);
});

test("currentToolResults ignores calls before the latest human user boundary", () => {
  const raw = request([user("first"), { type: "function_call", call_id: "call_old", name: "read", arguments: "{}" }, { type: "function_call_output", call_id: "call_old", output: "old" }, { role: "assistant", content: [{ type: "output_text", text: "done" }] }, user("second")]);
  assert.deepEqual(currentToolResults(raw), []);
});

test("currentToolResults returns only current provider-round outputs", () => {
  const raw = request([user("read it"), { type: "function_call", call_id: "call_a", name: "read", arguments: "{}" }, { type: "function_call_output", call_id: "call_a", output: "hello" }]);
  assert.deepEqual(currentToolResults(raw), [{ callId: "call_a", output: "hello" }]);
});

test("tool revisions are stable across key order and change with schema", () => {
  const left = toolRevision({ name: "read", description: "Read", parameters: { type: "object", properties: { b: { type: "string" }, a: { type: "string" } } } });
  const right = toolRevision({ name: "read", description: "Read", parameters: { properties: { a: { type: "string" }, b: { type: "string" } }, type: "object" } });
  const changed = toolRevision({ name: "read", description: "Read", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "string" } } } });
  assert.equal(left, right); assert.notEqual(left, changed);
});

test("environment enforces schema revision, tool_choice, and parallel policy", () => {
  const raw = request([user("x")], { tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object" } }], tool_choice: { type: "function", name: "read" }, parallel_tool_calls: false });
  const environment = environmentFromResponsesRequest(raw, "session-a");
  const read = environment.tools[0]!;
  assert.equal(validateToolInvocation(environment, { name: "read", revision: read.revision }).name, "read");
  assert.throws(() => validateToolInvocation(environment, { name: "read", revision: "tool_stale" }), ToolSchemaChangedError);
  assert.throws(() => validateToolInvocation(environment, { name: "read", revision: read.revision }, 1), ParallelToolCallError);
  const none = environmentFromResponsesRequest({ ...raw, tool_choice: "none" }, "session-a");
  assert.throws(() => validateToolInvocation(none, { name: "read", revision: none.tools[0]!.revision }), ToolPolicyError);
});

test("read continuation reuses exactly one browser session", () => {
  let browserStarts = 0;
  const registry = new TurnCorrelationRegistry<{ browser: number }>();
  const r0 = request([user("read README")]);
  const first = registry.resolve({ clientSessionId: "session-a", rawRequest: r0, currentCallIds: [], start: () => ({ browser: ++browserStarts }) });
  registry.bindCalls(first.sessionId, "session-a", ["call_read"]);
  const r1 = request([user("read README"), { type: "function_call", call_id: "call_read", name: "read", arguments: "{\"filePath\":\"README.md\"}" }, { type: "function_call_output", call_id: "call_read", output: "contents" }]);
  const second = registry.resolve({ clientSessionId: "session-a", rawRequest: r1, currentCallIds: currentToolResults(r1).map(result => result.callId), start: () => ({ browser: ++browserStarts }) });
  assert.equal(second.kind, "tool-continuation"); assert.equal(second.sessionId, first.sessionId); assert.equal(browserStarts, 1);
  registry.markDelivered(second.sessionId, "session-a", "call_read"); registry.settleSession(second.sessionId, "session-a");
});

test("HTTP retry is idempotent and does not start a second browser", () => {
  let browserStarts = 0; const registry = new TurnCorrelationRegistry<object>(); const r0 = request([user("read README")]);
  const first = registry.resolve({ clientSessionId: "session-a", rawRequest: r0, currentCallIds: [], start: () => ({ n: ++browserStarts }) });
  const retry = registry.resolve({ clientSessionId: "session-a", rawRequest: r0, currentCallIds: [], start: () => ({ n: ++browserStarts }) });
  assert.equal(retry.kind, "request-retry"); assert.equal(retry.sessionId, first.sessionId); assert.equal(browserStarts, 1);
});

test("delivered call retry resolves to the same session without duplicate execution", () => {
  const registry = new TurnCorrelationRegistry<object>(); const r0 = request([user("read")]);
  const first = registry.resolve({ clientSessionId: "session-a", rawRequest: r0, currentCallIds: [], start: () => ({}) });
  registry.bindCalls(first.sessionId, "session-a", ["call_a"]); registry.markDelivered(first.sessionId, "session-a", "call_a");
  const r1 = request([user("read"), { type: "function_call_output", call_id: "call_a", output: "ok" }]);
  const resolved = registry.resolve({ clientSessionId: "session-a", rawRequest: r1, currentCallIds: ["call_a"], start: () => ({ fresh: true }) });
  assert.equal(resolved.kind, "delivered-replay"); assert.equal(resolved.sessionId, first.sessionId);
});

test("call_id is scoped to X-Session-Id", () => {
  const registry = new TurnCorrelationRegistry<object>();
  const first = registry.resolve({ clientSessionId: "parent", rawRequest: request([user("read")]), currentCallIds: [], start: () => ({}) });
  registry.bindCalls(first.sessionId, "parent", ["call_a"]);
  assert.throws(() => registry.resolve({ clientSessionId: "child", rawRequest: request([user("read"), { type: "function_call_output", call_id: "call_a", output: "x" }]), currentCallIds: ["call_a"], start: () => ({}) }), /different OpenCode session/);
});

test("a new human turn does not resume a historical call_id", () => {
  let browserStarts = 0; const registry = new TurnCorrelationRegistry<object>();
  const first = registry.resolve({ clientSessionId: "session-a", rawRequest: request([user("first")]), currentCallIds: [], start: () => ({ n: ++browserStarts }) });
  registry.bindCalls(first.sessionId, "session-a", ["call_old"]); registry.markDelivered(first.sessionId, "session-a", "call_old"); registry.settleSession(first.sessionId, "session-a");
  const secondRaw = request([user("first"), { type: "function_call_output", call_id: "call_old", output: "old" }, { role: "assistant", content: [{ type: "output_text", text: "done" }] }, user("second")]);
  const current = currentToolResults(secondRaw); assert.deepEqual(current, []);
  const second = registry.resolve({ clientSessionId: "session-a", rawRequest: secondRaw, currentCallIds: [], start: () => ({ n: ++browserStarts }) });
  assert.equal(second.kind, "new"); assert.notEqual(second.sessionId, first.sessionId); assert.equal(browserStarts, 2);
});

test("abort retires call ids so a late continuation cannot attach", () => {
  let now = 0; const registry = new TurnCorrelationRegistry<object>({ now: () => now, activeTtlMs: 100, retiredCallTtlMs: 1000 });
  const first = registry.resolve({ clientSessionId: "session-a", rawRequest: request([user("read")]), currentCallIds: [], start: () => ({}) });
  registry.bindCalls(first.sessionId, "session-a", ["call_abort"]); registry.abortSession(first.sessionId, "session-a", "client abort");
  assert.throws(() => registry.resolve({ clientSessionId: "session-a", rawRequest: request([user("read"), { type: "function_call_output", call_id: "call_abort", output: "late" }]), currentCallIds: ["call_abort"], start: () => ({}) }), /retired/);
  now = 1001; assert.equal(registry.counts().retiredCalls, 0);
});

test("function_call_output image data URL becomes native MCP image content", async () => {
  const { brokerResultFromFunctionCallOutput } = await import("../src/adapters/chatgpt-web/opencode-integration.ts");
  assert.deepEqual(brokerResultFromFunctionCallOutput([{ type: "input_text", text: "screenshot" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }]), {
    content: [{ type: "text", text: "screenshot" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  });
});

test("active TTL retirement cancels the underlying browser session and tombstones its calls", () => {
  let now = 0; const retired: Array<{ session: { cancelled: boolean }; reason: string }> = []; const session = { cancelled: false };
  const registry = new TurnCorrelationRegistry<typeof session>({ now: () => now, activeTtlMs: 100, retiredCallTtlMs: 1000, onRetire: (value, reason) => { value.cancelled = true; retired.push({ session: value, reason }); } });
  const first = registry.resolve({ clientSessionId: "session-ttl", rawRequest: request([user("read")]), currentCallIds: [], start: () => session });
  registry.bindCalls(first.sessionId, "session-ttl", ["call_ttl"]); now = 100;
  assert.equal(registry.counts().retiredCalls, 1); assert.equal(session.cancelled, true); assert.match(retired[0]!.reason, /TTL expired/);
});

test("duplicate function_call_output in the current provider round fails closed", () => {
  const raw = request([user("read"), { type: "function_call_output", call_id: "call_dup", output: "one" }, { type: "function_call_output", call_id: "call_dup", output: "two" }]);
  assert.throws(() => currentToolResults(raw), /duplicate function_call_output/);
});
