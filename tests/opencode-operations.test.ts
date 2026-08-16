import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("runtime configurator switches to a fresh OpenCode connector identity without touching tunnel authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocgw-config-"));
  const path = join(dir, "config.json");
  const original = {
    version: 3, host: "127.0.0.1", mode: "full", appName: "Codex Native2",
    tunnel: { tunnelId: "tunnel_0123456789abcdef0123456789abcdef", keep: "authority" },
    controlToken: "x".repeat(48),
  };
  await writeFile(path, JSON.stringify(original));
  try {
    const script = fileURLToPath(new URL("../scripts/configure-opencode-runtime.py", import.meta.url));
    const python = process.platform === "win32" ? "python" : "python3";
    const run = spawnSync(python, [script, path], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const configured = JSON.parse(await readFile(path, "utf8"));
    assert.equal(configured.appName, "OpenCode Native1");
    assert.deepEqual(configured.tunnel, original.tunnel);
    const backup = JSON.parse(await readFile(`${path}.before-opencode`, "utf8"));
    assert.equal(backup.appName, "Codex Native2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live smoke client performs R0 function_call then R1 function_call_output with one session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocgw-smoke-"));
  const file = join(dir, "README.md");
  await writeFile(file, "# Smoke File\nsecond line\n");
  const seen: Array<{ session: string | undefined; body: any }> = [];
  const server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      const body = JSON.parse(data);
      seen.push({ session: req.headers["x-session-id"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      if (seen.length === 1) {
        res.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", call_id: "call_smoke", name: "read", arguments: JSON.stringify({ filePath: file }) }] }));
        return;
      }
      res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "# Smoke File" }] }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  try {
    const script = fileURLToPath(new URL("../scripts/live-browser-smoke.mjs", import.meta.url));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [script, file], {
        env: { ...process.env, OPENCODE_CHATGPT_WEB_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", rejectChild);
      child.once("close", code => resolveChild({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /PASS: # Smoke File/);
    assert.equal(seen.length, 2);
    assert.ok(seen[0]!.session);
    assert.equal(seen[1]!.session, seen[0]!.session);
    assert.equal(seen[0]!.body.tool_choice.type, "function");
    assert.equal(seen[0]!.body.tool_choice.name, "read");
    assert.equal(seen[1]!.body.tool_choice, "none");
    const output = seen[1]!.body.input.find((item: any) => item.type === "function_call_output");
    assert.equal(output.call_id, "call_smoke");
    assert.match(output.output, /# Smoke File/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
