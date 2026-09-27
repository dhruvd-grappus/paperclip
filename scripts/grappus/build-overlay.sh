#!/usr/bin/env bash
# Build the Grappus overlay: the fork's server + UI build, laid over the upstream
# npm install on our host by paperclip-overlay (dev-pipe repo, vps/).
#
#   scripts/grappus/build-overlay.sh <out dir>
#
# Writes <out>/paperclip-overlay.tgz (dist/, ui-dist/, GRAPPUS_BUILD) and
# <out>/paperclip-overlay.tgz.sha256. Needs `pnpm install` done. Used by
# .github/workflows/grappus-overlay.yml and by `make paperclip-deploy-local`.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
BASE=$(cat "$ROOT/scripts/grappus/BASE")
cd "$ROOT"

git rev-parse -q --verify "refs/tags/v$BASE" >/dev/null || { echo "build-overlay: tag v$BASE missing (fetch tags)" >&2; exit 1; }
git merge-base --is-ancestor "v$BASE" HEAD || { echo "build-overlay: v$BASE is not an ancestor of HEAD" >&2; exit 1; }
SHA=$(git rev-parse --short=12 HEAD)
BUILD=$(git rev-list --count "v$BASE..HEAD")
BRANCH=${GRAPPUS_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}
echo "==> building $BASE-grappus.$BUILD ($SHA)"

# The runner's full build needs cargo for runnerd; the server only needs its TypeScript output.
(cd packages/paperclip-runner && ${PNPM:-pnpm} run --silent build:typescript >/dev/null)
rm -rf server/dist
(cd server && npx tsc -p .)
# Sidebar build badge + changelog (server/dist/grappus-build.json).
node scripts/write-grappus-build.mjs "$BASE" "$BUILD"
(cd ui && npx vite build --logLevel error)

STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude 'vendor/' server/dist/ "$STAGE/dist/"
rsync -a ui/dist/ "$STAGE/ui-dist/"
jq -n --arg base "$BASE" --arg build "$BUILD" --arg sha "$SHA" --arg branch "$BRANCH" --arg t "$(date -u +%FT%TZ)" \
  '{base:$base, build:$build, sha:$sha, branch:$branch, builtAt:$t}' > "$STAGE/GRAPPUS_BUILD"
tar_flags=()
tar --version 2>/dev/null | grep -q bsdtar && tar_flags+=(--no-xattrs)
COPYFILE_DISABLE=1 tar "${tar_flags[@]}" -czf "$OUT/paperclip-overlay.tgz" -C "$STAGE" dist ui-dist GRAPPUS_BUILD
(cd "$OUT" && { command -v sha256sum >/dev/null && sha256sum paperclip-overlay.tgz || shasum -a 256 paperclip-overlay.tgz; } > paperclip-overlay.tgz.sha256)
echo "==> $OUT/paperclip-overlay.tgz ($(du -h "$OUT/paperclip-overlay.tgz" | cut -f1)) build $BUILD $SHA"
