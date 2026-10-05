#!/usr/bin/env bash
# Tests that gate a Grappus overlay release. Needs scripts/grappus/prepare.sh first.
#
#   scripts/grappus/test.sh [--since <sha>] [--shard <i>/<n>]
#
# Which files run is decided by scripts/grappus/select-tests.mjs: with --since,
# only the tests touched or neighbouring the changes since that commit (plus the
# core suites); without it, every test file the fork touched since the upstream
# base. --shard runs one slice of the server suites; shard 1 also typechecks and
# runs the UI suites. The full upstream suite (15k tests, some macOS/cloud-only)
# is not a gate here.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

selection=$(node scripts/grappus/select-tests.mjs "$@")
mode=$(jq -r .mode <<<"$selection")
shard=$(jq -r '.shard // "1/1"' <<<"$selection")
server_tests=$(jq -r '.server[]' <<<"$selection")
ui_tests=$(jq -r '.ui[]' <<<"$selection")
echo "==> mode: $mode, shard: $shard, since: $(jq -r '.since // "-"' <<<"$selection")"

if [[ "$shard" == 1/* ]]; then
  (cd server && npx tsc --noEmit -p .)
  (cd ui && npx tsc --noEmit -p .)
fi

echo "==> server: $(echo "$server_tests" | grep -c . || true) file(s)"
if [ -n "$server_tests" ]; then (cd server && npx vitest run $server_tests); fi
echo "==> ui: $(echo "$ui_tests" | grep -c . || true) file(s)"
if [ -n "$ui_tests" ]; then (cd ui && npx vitest run $ui_tests); fi
