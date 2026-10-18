#!/usr/bin/env bash
# Runs the end-to-end test against a local Worker and a fake Strava. No real Strava account needed.
set -euo pipefail
set -m # background jobs get their own process groups, so cleanup also stops wrangler's child processes
cd "$(dirname "$0")/.."
printf 'STRAVA_CLIENT_ID=" 1 "\nSTRAVA_CLIENT_SECRET=test-secret\nSTRAVA_OAUTH_BASE=http://127.0.0.1:9999/oauth\nSTRAVA_API_BASE=http://127.0.0.1:9999/api/v3\n' > test/.dev.vars
node test/mock-strava.mjs > /dev/null 2>&1 & MOCK_PID=$!
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost npx wrangler dev -c test/wrangler.test.jsonc --port 8788 --persist-to "$(mktemp -d)" > /dev/null 2>&1 & WR_PID=$!
trap 'kill -- -$MOCK_PID -$WR_PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:8788/ && break; sleep 1; done
node test/e2e.mjs
