#!/usr/bin/env bash
# Build the Grappus overlay: the fork's server + UI build, laid over the upstream
# npm install on our host by paperclip-overlay (dev-pipe repo, vps/).
#
#   scripts/grappus/build-overlay.sh <out dir>
#
# Writes <out>/paperclip-overlay.tgz (dist/, ui-dist/, pkg-dist/<pkg>/ for changed
# workspace packages, GRAPPUS_BUILD) and <out>/paperclip-overlay.tgz.sha256.
# Needs `pnpm install` done. Used by .github/workflows/grappus-overlay.yml and
# by `make paperclip-deploy-local`.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
BASE=$(cat "$ROOT/scripts/grappus/BASE")
PNPM=${PNPM:-pnpm}
cd "$ROOT"

git rev-parse -q --verify "refs/tags/v$BASE" >/dev/null || { echo "build-overlay: tag v$BASE missing (fetch tags)" >&2; exit 1; }
git merge-base --is-ancestor "v$BASE" HEAD || { echo "build-overlay: v$BASE is not an ancestor of HEAD" >&2; exit 1; }
SHA=$(git rev-parse --short=12 HEAD)
BUILD=$(git rev-list --count "v$BASE..HEAD")
BRANCH=${GRAPPUS_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}
echo "==> building $BASE-grappus.$BUILD ($SHA)"

# Needs scripts/grappus/prepare.sh first (runner TypeScript + workspace deps).
rm -rf server/dist
(cd server && npx tsc -p .)
# Sidebar build badge + changelog (server/dist/grappus-build.json).
node scripts/write-grappus-build.mjs "$BASE" "$BUILD"
(cd ui && npx vite build --logLevel error)

STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude 'vendor/' server/dist/ "$STAGE/dist/"
rsync -a ui/dist/ "$STAGE/ui-dist/"
# Workspace packages the server loads at runtime from node_modules/@paperclipai/*.
# server/dist alone is not enough when one of them changes: the host install keeps
# the pristine upstream package dist, so new imports fail at boot (build 20:
# server/dist/routes/stats.js needed statsOverviewQuerySchema from @paperclipai/shared,
# which the old shared/dist did not export). Stage the full dist/ of every changed
# @paperclipai/* workspace package (except server itself, shipped as dist/, and the
# vendored runner, owned by runner-shim.sh). Unchanged packages ship nothing.
STAGED_PKGS=()
for pkgdir in packages/*/; do
  [ -f "${pkgdir}package.json" ] || continue
  pname=$(node -p "require('./${pkgdir}package.json').name") || continue
  case "$pname" in @paperclipai/*) ;; *) continue ;; esac
  short=${pname#@paperclipai/}
  case "$short" in server|paperclip-runner) continue ;; esac
  if git diff --quiet "v$BASE..HEAD" -- "$pkgdir"; then continue; fi
  # Rebuild unconditionally: prepare.sh already did this on CI, but a local run may
  # carry a stale dist/ from an older checkout, which would ship old code.
  echo "==> building $pname"
  (cd "$pkgdir" && "$PNPM" run build)
  mkdir -p "$STAGE/pkg-dist/$short"
  rsync -a --delete --exclude 'vendor/' "${pkgdir}dist/" "$STAGE/pkg-dist/$short/"
  STAGED_PKGS+=("$short")
done
if [ ${#STAGED_PKGS[@]} -gt 0 ]; then echo "==> workspace package dists: ${STAGED_PKGS[*]}"; fi
pkgs_json=$(printf '%s\n' "${STAGED_PKGS[@]}" | jq -R . | jq -s 'map(select(length > 0))')
jq -n --arg base "$BASE" --arg build "$BUILD" --arg sha "$SHA" --arg branch "$BRANCH" --arg t "$(date -u +%FT%TZ)" \
  --argjson packages "$pkgs_json" \
  '{base:$base, build:$build, sha:$sha, branch:$branch, builtAt:$t, packages:$packages}' > "$STAGE/GRAPPUS_BUILD"
tar_flags=()
tar --version 2>/dev/null | grep -q bsdtar && tar_flags+=(--no-xattrs)
tar_args=(dist ui-dist GRAPPUS_BUILD)
if [ ${#STAGED_PKGS[@]} -gt 0 ]; then tar_args+=(pkg-dist); fi
COPYFILE_DISABLE=1 tar "${tar_flags[@]}" -czf "$OUT/paperclip-overlay.tgz" -C "$STAGE" "${tar_args[@]}"
(cd "$OUT" && { command -v sha256sum >/dev/null && sha256sum paperclip-overlay.tgz || shasum -a 256 paperclip-overlay.tgz; } > paperclip-overlay.tgz.sha256)
echo "==> $OUT/paperclip-overlay.tgz ($(du -h "$OUT/paperclip-overlay.tgz" | cut -f1)) build $BUILD $SHA"
