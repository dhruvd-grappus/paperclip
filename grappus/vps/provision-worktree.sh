#!/usr/bin/env bash
# Paperclip worktree provisioner. Runs inside a freshly created worktree (cwd) right after checkout.
# Goal: never cold-start. Reuse the primary clone's node_modules via hard links when the lockfile matches,
# otherwise install from the warm npm/pnpm/yarn cache. Also seeds the Next.js build cache.
# Set as executionWorkspacePolicy.workspaceStrategy.provisionCommand on every project.
set -euo pipefail
log() { echo "[provision] $*"; }
WT="$(pwd)"
PRIMARY_ROOT="/home/paperclip/.paperclip/instances/default/projects"

# find the primary clone of this repo: same remote url, outside the worktrees dir
REMOTE="$(git config --get remote.origin.url 2>/dev/null || true)"
PRIMARY=""
if [ -n "$REMOTE" ]; then
  while IFS= read -r d; do
    if [ "$(git -C "$d" config --get remote.origin.url 2>/dev/null || true)" = "$REMOTE" ]; then PRIMARY="$d"; break; fi
  done < <(find "$PRIMARY_ROOT" -maxdepth 3 -mindepth 3 -type d 2>/dev/null)
fi
log "worktree=$WT primary=${PRIMARY:-none}"

hash_of() { [ -f "$1" ] && sha256sum "$1" | cut -c1-16 || echo none; }

if [ -f package.json ]; then
  if   [ -f pnpm-lock.yaml ]; then PM=pnpm; LOCK=pnpm-lock.yaml; INSTALL="pnpm install --frozen-lockfile --prefer-offline"
  elif [ -f yarn.lock ];      then PM=yarn; LOCK=yarn.lock;      INSTALL="yarn install --immutable"
  elif [ -f bun.lockb ];      then PM=bun;  LOCK=bun.lockb;      INSTALL="bun install --frozen-lockfile"
  else                              PM=npm;  LOCK=package-lock.json; INSTALL="npm ci --prefer-offline --no-audit --no-fund"; fi

  if [ ! -d node_modules ]; then
    if [ -n "$PRIMARY" ] && [ -d "$PRIMARY/node_modules" ] && [ "$(hash_of "$LOCK")" = "$(hash_of "$PRIMARY/$LOCK")" ]; then
      log "linking node_modules from primary ($PM, lockfile match)"
      cp -al "$PRIMARY/node_modules" node_modules
    else
      log "installing with $PM (cache-backed)"
      $INSTALL
      # refresh the primary's node_modules so the next worktree links instead of installing
      if [ -n "$PRIMARY" ] && [ "$(hash_of "$LOCK")" != "$(hash_of "$PRIMARY/$LOCK")" ]; then
        log "primary lockfile differs; leaving primary untouched"
      elif [ -n "$PRIMARY" ] && [ ! -d "$PRIMARY/node_modules" ]; then
        log "seeding primary node_modules"; cp -al node_modules "$PRIMARY/node_modules" || true
      fi
    fi
  fi
  # Next.js: seed the persistent compiler cache so dev/build does not start from zero
  if [ -n "$PRIMARY" ] && [ -d "$PRIMARY/.next/cache" ] && [ ! -d .next/cache ]; then
    mkdir -p .next && cp -al "$PRIMARY/.next/cache" .next/cache && log "seeded .next/cache"
  fi
fi

# Playwright browsers are per-user (~/.cache/ms-playwright), already installed; nothing to do per worktree.
log "done"

# Copy gitignored env files from the primary clone (Next apps 500 on every route without NEXT_PUBLIC_* values).
if [ -n "${PRIMARY:-}" ]; then
  for f in .env.local .env.development.local; do
    [ -f "$PRIMARY/$f" ] && [ ! -f "./$f" ] && cp "$PRIMARY/$f" "./$f" && echo "[provision] copied $f from primary"
  done
fi

exit 0
