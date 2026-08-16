#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const base = (process.env.OPENCODE_CHATGPT_WEB_BASE_URL || "http://127.0.0.1:17841/v1").replace(/\/$/, "");
const filePath = resolve(process.argv[2] || "README.md");
const sessionId = `smoke_${randomBytes(12).toString("hex")}`;
const headers = {
  "content-type": "application/json",
  authorization: "Bearer local-chatgpt-web",
  "X-Session-Id": sessionId,
};

async function responses(body) {
  const response = await fetch(`${base}/responses`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`non-JSON Responses reply (${response.status}): ${text.slice(0, 1000)}`); }
  if (!response.ok || json?.error) throw new Error(`Responses failed (${response.status}): ${JSON.stringify(json?.error ?? json)}`);
  return json;
}

const user = {
  role: "user",
  content: [{
    type: "input_text",
    text: "Use the read tool exactly once on the requested path. After the tool result arrives, answer with the first non-empty line and do not call any more tools.",
  }],
};
const readTool = {
  type: "function",
  name: "read",
  description: "Read a UTF-8 file from the local outer runtime.",
  parameters: {
    type: "object",
    properties: { filePath: { type: "string" } },
    required: ["filePath"],
    additionalProperties: false,
  },
  strict: false,
};

console.log(`[smoke] R0 session=${sessionId}`);
const r0 = await responses({
  model: "gpt-5.6-sol",
  reasoning: { effort: "low" },
  stream: false,
  input: [user],
  tools: [readTool],
  tool_choice: { type: "function", name: "read" },
  parallel_tool_calls: false,
});
const call = (r0.output || []).find(item => item?.type === "function_call" && item?.name === "read");
if (!call?.call_id) throw new Error(`R0 did not produce read function_call: ${JSON.stringify(r0.output)}`);
console.log(`[smoke] function_call ${call.call_id}`);

const localText = await readFile(filePath, "utf8");
const output = localText.slice(0, 50_000);
console.log(`[smoke] outer executor read ${filePath} (${output.length} chars)`);

console.log("[smoke] R1 function_call_output -> same browser response");
const r1 = await responses({
  model: "gpt-5.6-sol",
  reasoning: { effort: "low" },
  stream: false,
  input: [
    user,
    { type: "function_call", call_id: call.call_id, name: "read", arguments: call.arguments || "{}" },
    { type: "function_call_output", call_id: call.call_id, output },
  ],
  tools: [readTool],
  tool_choice: "none",
  parallel_tool_calls: false,
});
const finalText = (r1.output || [])
  .filter(item => item?.type === "message")
  .flatMap(item => item.content || [])
  .filter(part => part?.type === "output_text")
  .map(part => part.text || "")
  .join("");
if (!finalText.trim()) throw new Error(`R1 did not produce final text: ${JSON.stringify(r1.output)}`);
console.log(`[smoke] PASS: ${finalText.trim().slice(0, 500)}`);
console.log("[smoke] continuation succeeded across one function_call boundary; inspect daemon logs to confirm a single browser start.");
