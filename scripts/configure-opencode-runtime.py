#!/usr/bin/env python3
"""Point the audited upstream runtime at a fresh OpenCode-specific ChatGPT connector identity.

Run this after the upstream `setup --full` step has created a valid version-3 config/tunnel.
It deliberately does not rename/reuse a ChatGPT connector; create a NEW connector named
`OpenCode Native1` against the configured tunnel so ChatGPT cannot reuse cached Codex MCP schemas.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import sys

CONNECTOR = "OpenCode Native1"

def config_path() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).expanduser().resolve()
    home = os.environ.get("CODEX_CHATGPT_WEB_HOME", "").strip()
    root = Path(home).expanduser() if home else Path.home() / ".codex-chatgpt-web"
    return (root / "config.json").resolve()

path = config_path()
if not path.exists():
    raise SystemExit(f"runtime config not found: {path}; run upstream setup --full first")
raw = json.loads(path.read_text())
if not isinstance(raw, dict) or raw.get("version") != 3:
    raise SystemExit(f"expected version-3 runtime config: {path}")
if raw.get("host") != "127.0.0.1":
    raise SystemExit("refusing non-loopback runtime config")
if raw.get("mode") != "full":
    raise SystemExit("OpenCode local tools require runtime mode=full; rerun setup --full first")
if not isinstance(raw.get("tunnel"), dict):
    raise SystemExit("full mode config is missing tunnel configuration")

backup = path.with_suffix(path.suffix + ".before-opencode")
if not backup.exists():
    shutil.copy2(path, backup)
raw["appName"] = CONNECTOR

tmp = path.with_suffix(path.suffix + ".tmp-opencode")
tmp.write_text(json.dumps(raw, indent=2) + "\n")
try:
    os.chmod(tmp, 0o600)
except OSError:
    pass
tmp.replace(path)
try:
    os.chmod(path, 0o600)
except OSError:
    pass
print(f"configured {path}")
print(f"ChatGPT connector name: {CONNECTOR}")
print("Create this as a NEW connector against the same tunnel; do not rename an existing Codex connector.")
