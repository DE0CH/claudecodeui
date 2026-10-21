#!/bin/bash
# Local end-to-end check of Jarvis mode, no cloud and no model cost: a mock Anthropic API, a fake Jarvis 3 web role +
# sandbox agent (/proc runs the local `claude` CLI with /workspace bind-mounted from $JFS/ws/<conversation>), the real
# CloudCLI server, and a client that creates a session, chats over /ws and checks history, files and delete.
# Needs: local Postgres (postgres://claude:dev@127.0.0.1:5432/postgres), `claude` on PATH, sudo (bind mount).
# Knobs: MOCK_MODE=ok|write|budget, FAKE_SANDBOX_FAIL=503, JARVIS_LOCALE=zh-HK, RAW_PATH=report/hello.txt, DELETE=1.
# State goes to $E2E_DIR (default ~/artifacts/agent-A/e2e).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel)
sudo fuser -k 13901/tcp 17070/tcp 18080/tcp >/dev/null 2>&1
E=$HERE; R=${E2E_DIR:-$HOME/artifacts/agent-A/e2e}/run; rm -rf $R; mkdir -p $R/jfs/users/u1/claude $R/uihome $R/sbxhome
ln -sfn $R/jfs/users/u1/claude $R/uihome/.claude; ln -sfn $R/jfs/users/u1/claude $R/sbxhome/.claude
sudo mkdir -p /workspace
MOCK_MODE=${MOCK_MODE:-ok} MOCK_PORT=18080 node $E/mock-anthropic.mjs > $R/mock.log 2>&1 & M=$!
JFS=$R/jfs SANDBOX_HOME=$R/sbxhome MOCK_URL=http://127.0.0.1:18080 FAKE_PORT=17070 node $E/fake-jarvis.mjs > $R/fake.log 2>&1 & F=$!
cd "$REPO"
env -i PATH=$PATH HOME=$R/uihome VITE_IS_PLATFORM=true HOST=127.0.0.1 SERVER_PORT=13901 TZ=UTC \
  DATABASE_URL=postgres://claude:dev@127.0.0.1:5432/postgres DATABASE_SCHEMA=cc_e2e JWT_SECRET=e2e-secret \
  JARVIS_WEB_URL=http://127.0.0.1:17070 JARVIS_CC_TOKEN=cc-test-token JARVIS_CC_OWNER=staff@yyc.example \
  JARVIS_JFS_ROOT=$R/jfs JARVIS_MODEL=claude-sonnet-5-5 JARVIS_MODEL_LABEL="Sonnet 5.5" JARVIS_LOCALE=${JARVIS_LOCALE:-en} JARVIS_WATCH_INTERVAL_MS=1000 \
  npx tsx --tsconfig server/tsconfig.json server/index.ts > $R/server.log 2>&1 & S=$!
for i in $(seq 1 90); do curl -sf http://127.0.0.1:13901/health >/dev/null && break; sleep 1; done
node $E/client.mjs http://127.0.0.1:13901 staff@yyc.example "${PROMPT:-Say hello}" > $R/client.log 2>&1
kill $S $F $M 2>/dev/null; sudo fuser -k 13901/tcp 17070/tcp 18080/tcp >/dev/null 2>&1; sleep 1; sudo umount /workspace 2>/dev/null
PGPASSWORD=dev psql -h 127.0.0.1 -U claude -d postgres -qc 'drop schema if exists cc_e2e cascade' 2>/dev/null
cat $R/client.log
