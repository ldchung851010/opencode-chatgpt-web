# OpenCode → ChatGPT Web bridge

This fork ports the audited `miuuyy/codex-chatgpt-web` v2.1.10 code at commit
`809557a421b472682e6613c9070f564eaa2608ec` from Codex-native turn identity/tool authority to
OpenCode-native Responses semantics.

## What is implemented

- OpenCode `POST /v1/responses` with model `gpt-5.6-sol`.
- `X-Session-Id` is the session/security scope; `call_id` is the continuation key.
- Same browser response survives the HTTP tool boundary.
- Generic ChatGPT MCP surface only: `opencode_tool_inventory` and `opencode_tool_call`.
- OpenCode remains the executor for filesystem/shell/MCP/plugins/subagents/permissions.
- Per-tool SHA-256 schema revisions with stale-schema fail closed.
- `tool_choice` and `parallel_tool_calls` enforcement.
- Retry/idempotency, delivered-call replay, client abort tombstones, browser failure retirement.
- Latest-human-user boundary prevents stale historical `call_id` resurrection.
- Multimodal `function_call_output` preserves `input_image` data URLs as native MCP image content.
- Direct model routing (`gpt-5.6-sol` + `reasoning.effort`) with no executable Codex backend passthrough from the public routes.
- `/v1/models` is local-only; native Codex search/compaction routes are disabled in this fork.

## Checkout and targeted tests

```bash
git switch feat/opencode-vertical-slice
bun install --frozen-lockfile
bun run test:opencode
bun run typecheck
```

`test:opencode` is the fork acceptance suite. The inherited upstream `bun test` suite still contains Codex-specific contract tests and is useful as a compatibility audit, but those tests are not the authority for the OpenCode transport semantics.

## Runtime setup

Keep the upstream browser/tunnel runtime in `full` mode so ChatGPT Temporary Chat can reach the custom MCP connector. Run setup with a fresh connector identity:

```bash
bun run src/cli.ts setup --full --app-name "OpenCode Native1" ...
```

If a valid full-mode config already exists, `python scripts/configure-opencode-runtime.py` changes only its runtime `appName` to **OpenCode Native1**. Create a NEW ChatGPT connector with that exact name against the same tunnel; do not rename/reuse `Codex Native` or `Codex Native2`, because ChatGPT caches MCP contracts by connector identity.

Run the daemon on loopback port 17841 and merge `examples/opencode.json` into your OpenCode config. Before OpenCode itself, exercise the real browser/MCP two-round continuation with:

```bash
node scripts/live-browser-smoke.mjs README.md
```

OpenCode should select:

```text
chatgpt-web/gpt-5.6-sol
```

Variants map to ChatGPT Web effort as follows: `instant→low`, `medium→medium`, `high→high`, `extra-high→xhigh`, `pro→max`. Pro/max intentionally has no local MCP connector.

## Acceptance target

```text
OpenCode R0
  -> /v1/responses
  -> ChatGPT Temporary Chat Browser #1
  -> opencode_tool_call(read)
  -> Responses function_call(call_id)
OpenCode executes read exactly once
OpenCode R1
  -> function_call_output(call_id)
  -> same Browser #1 resumes
  -> final answer
```

Required invariants: `browserStarts === 1`, `readExecutions === 1`.

The daemon stays loopback-only. Browser profile and tunnel credentials are sensitive. This is an unofficial browser integration and deliberately fails closed rather than falling back to Codex backend inference or silently using `/chat/completions`.
