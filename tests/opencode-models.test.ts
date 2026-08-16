import assert from "node:assert/strict";
import test from "node:test";
import { OPENCODE_CHATGPT_SOL_MODEL, openCodeChatGptModelsList, resolveOpenCodeChatGptModelRoute } from "../src/adapters/chatgpt-web/opencode-models.ts";
import { localModelsResponseBody, requireLocalChatGptRoute } from "../src/adapters/chatgpt-web/opencode-server-routing.ts";

const plus = { solAvailable: true, proAvailable: false };
const pro = { solAvailable: true, proAvailable: true };

test("direct gpt-5.6-sol routing uses Responses reasoning.effort instead of chatgpt-web slugs", () => {
  assert.deepEqual(resolveOpenCodeChatGptModelRoute(OPENCODE_CHATGPT_SOL_MODEL, "medium", plus, true), {
    requestedModel: "gpt-5.6-sol", backendModel: "gpt-5.6-sol", effort: "medium", displayLabel: "Medium", localTools: true,
  });
  const max = resolveOpenCodeChatGptModelRoute(OPENCODE_CHATGPT_SOL_MODEL, "max", pro, true);
  assert.equal(max.displayLabel, "Pro");
  assert.equal(max.localTools, false);
});

test("xhigh/max remain account-gated and unknown models fail closed instead of passthrough", () => {
  assert.throws(() => resolveOpenCodeChatGptModelRoute("gpt-5.6-sol", "xhigh", plus, true), /not available/);
  assert.throws(() => requireLocalChatGptRoute({ model: "gpt-5.5", reasoning: { effort: "high" } }, pro, true), /Unsupported local ChatGPT Web model/);
});

test("local model catalog exposes only browser-backed models and needs no Codex upstream", () => {
  const list = localModelsResponseBody(pro) as { data: Array<{ id: string }> };
  assert.deepEqual(list.data.map(model => model.id), ["gpt-5.6-sol"]);
  assert.deepEqual(openCodeChatGptModelsList({ solAvailable: false, proAvailable: false }).data, [
    { id: "gpt-5.6-luna", object: "model", created: 0, owned_by: "chatgpt-web" },
  ]);
});

test("example OpenCode config maps every variant to a supported direct-model route", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(new URL("../examples/opencode.json", import.meta.url), "utf8"));
  assert.equal(config.model, "chatgpt-web/gpt-5.6-sol");
  assert.equal(config.provider["chatgpt-web"].npm, "@ai-sdk/openai");
  assert.equal(config.provider["chatgpt-web"].options.baseURL, "http://127.0.0.1:17841/v1");
  const variants = config.provider["chatgpt-web"].models["gpt-5.6-sol"].variants;
  const expected = { instant: "low", medium: "medium", high: "high", "extra-high": "xhigh", pro: "max" };
  for (const [name, effort] of Object.entries(expected)) {
    assert.equal(variants[name].reasoningEffort, effort);
    assert.equal(resolveOpenCodeChatGptModelRoute("gpt-5.6-sol", effort, pro, true).effort, effort);
  }
});
