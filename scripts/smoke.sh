#!/usr/bin/env bash
# Boots the server and asserts the core API surface works.
set -euo pipefail
cd "$(dirname "$0")/.."

export PORT=4317
node server.js &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$PORT/api/feasibility" >/dev/null 2>&1 && break; sleep 0.5; done

B="http://127.0.0.1:$PORT"
fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

curl -sf "$B/api/feasibility" | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert d['players'] > 10000, 'player count'
assert d['pools']['tp']['count'] > 100, 'tp pool'
assert d['pools']['tn']['count'] > 500, 'tn pool'
assert d['pools']['mt']['count'] > 1000, 'mt pool'
" || fail "feasibility"

G=$(curl -sf -X POST "$B/api/game/start" -H 'Content-Type: application/json' -d '{"team":"CHI"}')
GID=$(echo "$G" | python3 -c "import json,sys; g=json.load(sys.stdin); assert g['question']['prompt']; print(g['gameId'])") || fail "game start"

for i in 1 2 3 4 5; do
  R=$(curl -sf -X POST "$B/api/game/answer" -H 'Content-Type: application/json' -d "{\"gameId\":\"$GID\",\"answer\":\"zzz nobody\"}")
  echo "$R" | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert 'verdict' in d and d['verdict']['gained'] >= 0, 'answer verdict'
assert d['view']['status'] in ('active','kick'), 'status'
" || fail "answer $i"
done

curl -sf -X POST "$B/api/game/kick" -H 'Content-Type: application/json' -d "{\"gameId\":\"$GID\"}" | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert 17 < d['kick']['dist'] < 110, 'fg distance'
assert 0 < d['kick']['prob'] <= 96, 'fg odds'
assert d['kick']['made'] in (True, False), 'fg made'
" || fail "kick"

echo "SMOKE OK ✓"
