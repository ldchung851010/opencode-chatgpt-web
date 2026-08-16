import assert from "node:assert/strict";
import test from "node:test";
import { compileOpenCodeWebPrompt } from "../src/adapters/chatgpt-web/opencode-prompt.ts";

function request() {
  return {
    model: "gpt-5.6-sol",
    instructions: "Follow repository instructions.",
    input: [
      { role: "user", content: [
        { type: "input_text", text: "Inspect this image and README.md" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" },
      ] },
      { type: "function_call", call_id: "call_old", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_old", output: "old evidence" },
    ],
    tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object" } }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
  };
}

test("OpenCode prompt packages raw Responses history, schema output constraint, and image attachments", () => {
  const compiled = compileOpenCodeWebPrompt(request(), { localTools: true, displayLabel: "High", turnToken: "turn_abcdefghijklmnopqrstuvwxyz123456" });
  assert.equal(compiled.images.length, 1);
  assert.equal(compiled.images[0]!.imageUrl, "data:image/png;base64,aGVsbG8=");
  assert.match(compiled.text, /<opencode_context_json>/);
  assert.match(compiled.text, /Follow repository instructions/);
  assert.match(compiled.text, /json_schema/);
  assert.match(compiled.text, /opencode_tool_inventory/);
  assert.match(compiled.text, /opencode_tool_call/);
  assert.match(compiled.text, /turn_token turn_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(compiled.text, /opencode-input-image-1/);
  assert.doesNotMatch(compiled.text, /aGVsbG8=/);
  assert.doesNotMatch(compiled.text, /"tools":\[/);
  assert.doesNotMatch(compiled.text, /Codex Native/);
});

test("read-only OpenCode prompt rejects capability tokens and keeps prior tool evidence", () => {
  assert.throws(() => compileOpenCodeWebPrompt(request(), { localTools: false, displayLabel: "Pro", turnToken: "turn_bad" }), /must not receive/);
  const compiled = compileOpenCodeWebPrompt(request(), { localTools: false, displayLabel: "Pro" });
  assert.match(compiled.text, /no OpenCode local-tool bridge/);
  assert.match(compiled.text, /function_call_output/);
});
