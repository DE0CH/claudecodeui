#!/bin/bash
# The Jarvis 4 runtime bundle (`cloudcli-runtime-linux-x64.tar.gz`): what a Jarvis 4 session's `cloudcli` harness runs
# (DE0CH/jarvis4 session-image/base/harness-cloudcli.sh). It is fetched on first use, pinned by sha256 in jarvis4
# session-image/cloudcli-runtime.json, not baked into the session image (Fly refuses images over 8 GB unpacked).
#
#   node/      Node 22.23.3 (the version the YYC AI image runs)
#   app/       this fork built in Jarvis mode (VITE_JARVIS=true: chat-only UI), production node_modules only
#   postgres/  a portable PostgreSQL 18 (@embedded-postgres/linux-x64: initdb, pg_ctl, postgres + their libraries);
#              the fork keeps its state in Postgres and the session image has none
#
# Run on Ubuntu 24.04 (the session image's OS, so native modules link against its glibc), from the repo root:
#   jarvis/runtime-bundle.sh OUT_DIR
set -euo pipefail
OUT="$(realpath "${1:?usage: runtime-bundle.sh OUT_DIR}")"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION=22.23.3
PG_PACKAGE=@embedded-postgres/linux-x64@18.4.0-beta.17
B="$(mktemp -d)"
export HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false

curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$B"
mv "$B/node-v$NODE_VERSION-linux-x64" "$B/node"

mkdir -p "$B/app"
tar -C "$SRC" --exclude=./node_modules --exclude=./dist --exclude=./dist-server --exclude=./.git -cf - . | tar -C "$B/app" -xf -
cd "$B/app"
export PATH="$B/node/bin:$PATH"
npm ci
VITE_JARVIS=true npm run build
npm prune --omit=dev
npm cache clean --force
rm -rf src electron docker plugins redirect-package .github dist-server.old dist-server.next node_modules/.cache
# Size: the Agent SDK's own Claude Code binaries (the harness runs the session image's `claude`, CLAUDE_CLI_PATH) and
# Codex's (only Claude runs here): ~830 MB together
rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-* node_modules/@openai/codex-linux-*
rm -rf "$B/node/include" "$B/node/share"

mkdir -p "$B/pg" && cd "$B/pg"
npm pack -q "$PG_PACKAGE" >/dev/null
tar -xzf ./*.tgz
mv package/native "$B/postgres"
cd "$B/postgres"
python3 - <<'PY'
import json, os
for e in json.load(open("pg-symlinks.json")):
    t = e["target"].removeprefix("native/")
    if not os.path.lexists(t): os.symlink(os.path.basename(e["source"]), t)
PY
chmod +x bin/*
rm -rf "$B/pg"

# the bundle works on this OS: Postgres starts, the server's entry loads
LD_LIBRARY_PATH="$B/postgres/lib" "$B/postgres/bin/postgres" --version
"$B/node/bin/node" -e "require('$B/app/node_modules/node-pty'); require('$B/app/node_modules/sharp'); console.log('native modules load')"
test -f "$B/app/dist/index.html" && test -f "$B/app/dist-server/server/index.js"

tar -C "$B" -czf "$OUT/cloudcli-runtime-linux-x64.tar.gz" node app postgres
ls -la "$OUT/cloudcli-runtime-linux-x64.tar.gz"
