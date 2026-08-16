import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenCodeTurnController } from "../src/adapters/chatgpt-web/opencode-turn-controller.ts";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker.ts";
import { ChatGptTextFeed, ChatGptTraceFeed, type ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution.ts";
import type { OpenCodeTurnEnvironment } from "../src/adapters/chatgpt-web/tool-environment.ts";

function socket(name: string) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\ocgw-${process.pid}-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : join(tmpdir(), `ocgw-controller-${process.pid}-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}
function r0() { return { model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "Read README.md" }] }], tools: [{ type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } }] }; }
function fakeRuntime(broker: TurnBroker, path: string, env: OpenCodeTurnEnvironment, counters: { browserStarts: number }): ChatGptTurnRuntime {
  counters.browserStarts += 1;
  const trace = new ChatGptTraceFeed(); const text = new ChatGptTextFeed(); const abort = new AbortController(); let activeToken: string | undefined;
  const token = broker.register(env, 60_000, "controller").then(value => { activeToken = value; return value; });
  const browser = (async () => {
    const turnToken = await token;
    const claimed = await callTurnBroker<{ bindingId: string; environment: OpenCodeTurnEnvironment }>(path, { method: "claim", token: turnToken });
    const read = claimed.environment.tools.find(tool => tool.name === "read")!;
    const result = await callTurnBroker<{ content: Array<{ type: string; text?: string }> }>(path, { method: "invoke", bindingId: claimed.bindingId, name: "read", revision: read.revision, arguments: { filePath: "README.md" } }, null);
    if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
    const toolText = result.content.find(item => item.type === "text")?.text ?? "";
    const answer = `Final from same browser: ${toolText}`; text.push(answer); return answer;
  })();
  return { mode: "tools", token, browser, trace, text, cancel: () => { abort.abort(); if (activeToken) broker.revoke(activeToken); } };
}

async function closeBroker(broker: TurnBroker, path: string) { await broker.close(); if (!path.startsWith("\\\\.\\pipe\\") && existsSync(path)) rmSync(path, { force: true }); }

test("controller drives R0 -> function_call -> R1 output -> same pending browser -> final", async () => {
  const path = socket("vertical"); const broker = TurnBroker.forSocket(path); await broker.listen(); const controller = new OpenCodeTurnController({ broker }); const counters = { browserStarts: 0, readExecutions: 0 };
  try {
    const firstRequest = r0(); const first = await controller.run({ rawRequest: firstRequest, headers: { "X-Session-Id": "session-a" }, startRuntime: env => fakeRuntime(broker, path, env, counters) });
    assert.equal(first.type, "tools"); if (first.type !== "tools") throw new Error("expected tools"); assert.equal(counters.browserStarts, 1);
    counters.readExecutions += 1; const call = first.calls[0]!;
    const secondRequest = { ...firstRequest, input: [...firstRequest.input, { type: "function_call", call_id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) }, { type: "function_call_output", call_id: call.callId, output: "# README" }] };
    const second = await controller.run({ rawRequest: secondRequest, headers: { "X-Session-Id": "session-a" }, startRuntime: env => fakeRuntime(broker, path, env, counters) });
    assert.deepEqual(second, { type: "final", answer: "Final from same browser: # README", replay: false }); assert.equal(counters.browserStarts, 1); assert.equal(counters.readExecutions, 1);
  } finally { await closeBroker(broker, path); }
});

test("controller replays outstanding call on HTTP retry without duplicate browser start", async () => {
  const path = socket("retry"); const broker = TurnBroker.forSocket(path); await broker.listen(); const controller = new OpenCodeTurnController({ broker }); const counters = { browserStarts: 0 };
  try {
    const req = r0(); const first = await controller.run({ rawRequest: req, headers: { "X-Session-Id": "session-a" }, startRuntime: env => fakeRuntime(broker, path, env, counters) });
    const retry = await controller.run({ rawRequest: req, headers: { "X-Session-Id": "session-a" }, startRuntime: env => fakeRuntime(broker, path, env, counters) });
    assert.equal(first.type, "tools"); assert.equal(retry.type, "tools"); if (first.type === "tools" && retry.type === "tools") { assert.equal(retry.calls[0]!.callId, first.calls[0]!.callId); assert.equal(retry.replay, true); } assert.equal(counters.browserStarts, 1);
  } finally { await closeBroker(broker, path); }
});

test("real client abort retires the browser session so retry starts fresh", async () => {
  const path = socket("abort"); const broker = TurnBroker.forSocket(path); await broker.listen(); const controller = new OpenCodeTurnController({ broker }); let browserStarts = 0;
  const neverRuntime = (env: OpenCodeTurnEnvironment): ChatGptTurnRuntime => {
    browserStarts += 1; const trace = new ChatGptTraceFeed(); const text = new ChatGptTextFeed(); let activeToken: string | undefined;
    const token = broker.register(env, 60_000, "abort").then(value => { activeToken = value; return value; });
    return { mode: "tools", token, browser: new Promise<string>(() => {}), trace, text, cancel: () => { if (activeToken) broker.revoke(activeToken); } };
  };
  try {
    const req = r0(); const abort = new AbortController(); const pending = controller.run({ rawRequest: req, headers: { "X-Session-Id": "session-a" }, abortSignal: abort.signal, startRuntime: neverRuntime });
    setTimeout(() => abort.abort(), 10); await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError"); assert.equal(browserStarts, 1);
    const abort2 = new AbortController(); const retry = controller.run({ rawRequest: req, headers: { "X-Session-Id": "session-a" }, abortSignal: abort2.signal, startRuntime: neverRuntime });
    setTimeout(() => abort2.abort(), 10); await assert.rejects(retry, (error: unknown) => error instanceof DOMException && error.name === "AbortError"); assert.equal(browserStarts, 2);
  } finally { await closeBroker(broker, path); }
});

test("browser failure retires correlation so a retry can start a fresh browser", async () => {
  const path = socket("browser-failure"); const broker = TurnBroker.forSocket(path); await broker.listen(); const controller = new OpenCodeTurnController({ broker }); let browserStarts = 0;
  const failingRuntime = (env: OpenCodeTurnEnvironment): ChatGptTurnRuntime => { browserStarts += 1; const trace = new ChatGptTraceFeed(); const text = new ChatGptTextFeed(); return { mode: "tools", token: broker.register(env, 60_000, "failure"), browser: Promise.reject(new Error("browser closed")), trace, text, cancel: () => {} }; };
  try {
    const req = r0(); await assert.rejects(controller.run({ rawRequest: req, headers: { "X-Session-Id": "session-failure" }, startRuntime: failingRuntime }), /browser closed/);
    await assert.rejects(controller.run({ rawRequest: req, headers: { "X-Session-Id": "session-failure" }, startRuntime: failingRuntime }), /browser closed/); assert.equal(browserStarts, 2);
  } finally { await closeBroker(broker, path); }
});

test("tool_choice=required rejects a browser final that skipped the OpenCode tool boundary", async () => {
  const path = socket("required-final"); const broker = TurnBroker.forSocket(path); await broker.listen(); const controller = new OpenCodeTurnController({ broker }); let browserStarts = 0;
  try {
    const req = { ...r0(), tool_choice: "required" };
    await assert.rejects(controller.run({ rawRequest: req, headers: { "X-Session-Id": "session-required" }, startRuntime: env => { browserStarts += 1; const trace = new ChatGptTraceFeed(); const text = new ChatGptTextFeed(); text.push("I skipped the tool"); return { mode: "tools", token: broker.register(env, 60_000, "required"), browser: Promise.resolve("I skipped the tool"), trace, text, cancel: () => {} }; } }), /tool_choice=required requires a tool call/);
    assert.equal(browserStarts, 1);
  } finally { await closeBroker(broker, path); }
});

test("shared controller survives adapter-style factory recreation for the same broker socket", async () => {
  const { sharedOpenCodeTurnController, clearSharedOpenCodeTurnControllers } = await import("../src/adapters/chatgpt-web/opencode-turn-controller.ts"); const path = socket("shared-controller"); const broker = TurnBroker.forSocket(path);
  try { assert.equal(sharedOpenCodeTurnController({ broker }), sharedOpenCodeTurnController({ broker })); } finally { clearSharedOpenCodeTurnControllers(); await broker.close(); }
});

test("child OpenCode session gets its own browser while parent resumes its original browser", async () => {
  const path = socket("child-session"); const broker = TurnBroker.forSocket(path); await broker.listen(); const controller = new OpenCodeTurnController({ broker }); const counters = { browserStarts: 0 };
  try {
    const parentRequest = r0(); const parentFirst = await controller.run({ rawRequest: parentRequest, headers: { "X-Session-Id": "parent-session" }, startRuntime: env => fakeRuntime(broker, path, env, counters) });
    assert.equal(parentFirst.type, "tools"); if (parentFirst.type !== "tools") throw new Error("expected parent tool boundary"); assert.equal(counters.browserStarts, 1);
    const child = await controller.run({ rawRequest: { model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "Subtask analysis" }] }], tools: [] }, headers: { "X-Session-Id": "child-session", "x-parent-session-id": "parent-session" }, startRuntime: () => { counters.browserStarts += 1; const trace = new ChatGptTraceFeed(); const text = new ChatGptTextFeed(); text.push("child done"); return { mode: "read-only", browser: Promise.resolve("child done"), trace, text, cancel: () => {} }; } });
    assert.deepEqual(child, { type: "final", answer: "child done", replay: false }); assert.equal(counters.browserStarts, 2);
    const call = parentFirst.calls[0]!; const parentSecondRequest = { ...parentRequest, input: [...parentRequest.input, { type: "function_call", call_id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) }, { type: "function_call_output", call_id: call.callId, output: "parent data" }] };
    const parentFinal = await controller.run({ rawRequest: parentSecondRequest, headers: { "X-Session-Id": "parent-session" }, startRuntime: env => fakeRuntime(broker, path, env, counters) });
    assert.deepEqual(parentFinal, { type: "final", answer: "Final from same browser: parent data", replay: false }); assert.equal(counters.browserStarts, 2);
  } finally { await closeBroker(broker, path); }
});

test("plain read-only request completes without creating a tool boundary", async () => {
  const path = socket("read-only"); const broker = TurnBroker.forSocket(path); await broker.listen(); const controller = new OpenCodeTurnController({ broker }); let browserStarts = 0;
  try {
    const response = await controller.run({ rawRequest: { model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "Say hello" }] }], tools: [], tool_choice: "none" }, headers: { "X-Session-Id": "read-only-session" }, startRuntime: () => { browserStarts += 1; const trace = new ChatGptTraceFeed(); const text = new ChatGptTextFeed(); text.push("hello"); return { mode: "read-only", browser: Promise.resolve("hello"), trace, text, cancel: () => {} }; } });
    assert.deepEqual(response, { type: "final", answer: "hello", replay: false }); assert.equal(browserStarts, 1);
  } finally { await closeBroker(broker, path); }
});
