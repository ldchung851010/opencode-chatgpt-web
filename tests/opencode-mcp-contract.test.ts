import assert from "node:assert/strict";
import test from "node:test";
import { toolInventoryPage, requireInventoryTool } from "../src/adapters/chatgpt-web/mcp-contract.ts";
import { environmentFromResponsesRequest } from "../src/adapters/chatgpt-web/tool-environment.ts";

function environment() {
  return environmentFromResponsesRequest({
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }] }],
    tools: [
      { type: "function", name: "grep", description: "Search files", parameters: { type: "object" } },
      { type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } } } },
      { type: "function", name: "write", description: "Write a file", parameters: { type: "object" } },
    ],
  }, "session-a");
}

test("inventory exposes registry/tool revisions and supports search/pagination", () => {
  const env = environment();
  const page = toolInventoryPage(env, { query: "file", offset: 0, limit: 1, includeSchema: false });
  assert.equal(page.registry_revision, env.registryRevision);
  assert.equal(page.total, 3);
  assert.equal(page.tools.length, 1);
  assert.equal(page.has_more, true);
  assert.equal("parameters" in page.tools[0]!, false);
  assert.match(page.tools[0]!.revision, /^tool_[0-9a-f]{64}$/);
});

test("inventory exact revision guard rejects a stale model-side snapshot", () => {
  const env = environment();
  const read = env.tools.find(tool => tool.name === "read")!;
  assert.equal(requireInventoryTool(env, "read", read.revision), read);
  assert.throws(() => requireInventoryTool(env, "read", "tool_stale"), (error: unknown) =>
    error instanceof Error && (error as Error & { code?: string }).code === "ToolSchemaChanged");
});
