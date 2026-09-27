#!/usr/bin/env bash
# Tests that gate a Grappus overlay release: every test file the fork touched
# since the upstream base, plus the suites next to the code we changed. The full
# upstream suite (15k tests, some macOS/cloud-only) is not a gate here. Needs
# scripts/grappus/prepare.sh first.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE=$(cat "$ROOT/scripts/grappus/BASE")
cd "$ROOT"

(cd server && npx tsc --noEmit -p .)
(cd ui && npx tsc --noEmit -p .)

changed=$(git diff --name-only "v$BASE..HEAD" -- '*.test.ts' '*.test.tsx')
server_tests=$( { echo "$changed" | sed -n 's#^server/##p';
  printf '%s\n' src/__tests__/recovery-stale-issue-lock-sweep.test.ts src/__tests__/heartbeat-process-recovery.test.ts \
    src/__tests__/agent-conversations.test.ts src/services/runner-goals.test.ts; } | sort -u | grep . || true)
ui_tests=$( { echo "$changed" | sed -n 's#^ui/##p'; echo src/components/Sidebar.test.tsx; } | sort -u | grep . || true)

echo "==> server: $(echo "$server_tests" | wc -l | tr -d ' ') file(s)"
(cd server && npx vitest run $server_tests)
echo "==> ui: $(echo "$ui_tests" | wc -l | tr -d ' ') file(s)"
(cd ui && npx vitest run $ui_tests)
