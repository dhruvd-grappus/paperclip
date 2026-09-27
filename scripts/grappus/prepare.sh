#!/usr/bin/env bash
# Build what server and UI compile against, after `pnpm install` on a fresh
# checkout: the runner's TypeScript output (its full build needs cargo for
# runnerd, which the overlay never ships) and every other workspace package the
# server or UI depends on. Run once before test.sh / build-overlay.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
PNPM=${PNPM:-pnpm}
(cd packages/paperclip-runner && $PNPM run --silent build:typescript >/dev/null)
$PNPM --filter "@paperclipai/server^..." --filter "@paperclipai/ui^..." \
  --filter "!@paperclipai/paperclip-runner" run build
