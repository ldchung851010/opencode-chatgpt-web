# OpenCode → ChatGPT Web bridge

This fork ports the audited `miuuyy/codex-chatgpt-web` v2.1.10 code at commit
`809557a421b472682e6613c9070f564eaa2608ec` from Codex-native turn identity/tool authority to
OpenCode-native Responses semantics.

## What is implemented

- OpenCode `POST /v1/responses` with model `gpt-5.6-sol`.
- `X-Session-Id` is the session/security scope; `call_id` is the continuation key.
- Same browser response survives the HTTP tool boundary.
- Generic ChatGPT MCP surface only:
  - `opencode_tool_inventory`
  - `opencode_tool_call`
- OpenCode remains the executor for filesystem/shell/MCP/plugins/subagents/permissions.
- Per-tool SHA-256 schema revisions with stale-schema fail closed.
- `tool_choice` and `parallel_tool_calls` enforcement.
- Retry/idempotency, delivered-call replay, client abort tombstones, browser failure retirement.
- Latest-human-user boundary prevents stale historical `call_id` resurrection.
- Multimodal `function_call_output` preserves `input_image` data URLs as native MCP image content.
- Direct model routing (`gpt-5.6-sol` + `reasoning.effort`) with no Codex backend passthrough.
- `/v1/models` is local-only; native Codex search/compaction routes are disabled in this fork.

## Checkout

Use the fork branch `feat/opencode-vertical-slice`. The branch is based on the audited upstream
commit `809557a421b472682e6613c9070f564eaa2608ec` and contains the OpenCode adapter, local-only
server routing, tests, runtime helper scripts, and the sample OpenCode provider config.

```bash
git switch feat/opencode-vertical-slice
bun install --frozen-lockfile
bun run typecheck
bun test
```

## Runtime setup

The existing upstream browser/tunnel runtime is intentionally retained. For local OpenCode tools,
configure the daemon in `full` mode so the ChatGPT Temporary Chat can reach the custom MCP connector.
Pass `--app-name "OpenCode Native1"` to `setup --full`. If an existing full-mode config was already created, run `python scripts/configure-opencode-runtime.py`; it changes only the runtime `appName` to **OpenCode Native1**. Create a NEW ChatGPT connector with that exact name against the
same tunnel; do not rename/reuse `Codex Native` or `Codex Native2`, because ChatGPT caches MCP
contracts by connector identity. Then run the daemon on loopback port 17841 and merge
`examples/opencode.json` into your OpenCode config.

Before OpenCode itself, you can exercise the real browser/MCP two-round continuation with:

```bash
node scripts/live-browser-smoke.mjs README.md
```

OpenCode should select:

```text
chatgpt-web/gpt-5.6-sol
```

Variants map to ChatGPT Web effort as follows: `instant→low`, `medium→medium`, `high→high`,
`extra-high→xhigh`, `pro→max`. Pro/max intentionally has no local MCP connector.

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

## Security/behavior

The daemon stays loopback-only. Browser profile and tunnel credentials are sensitive. This is an
unofficial browser integration and deliberately fails closed rather than falling back to Codex
backend inference or silently using `/chat/completions`.
