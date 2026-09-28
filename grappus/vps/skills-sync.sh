#!/usr/bin/env bash
# Mirror skills added or edited in the Paperclip UI into the directory Clarifier reads.
#
# The Paperclip company skills store (<instances>/default/skills/<company>/<slug>/SKILL.md) is what the
# UI and the REST API write. The pipeline reads plain files from /home/paperclip/skills, so a skill
# added in the UI only reaches the agent after this sync. Core pipeline slugs are owned by
# deploy-native.py (git) and are never touched here.
# Cron (paperclip): */5 * * * * /home/paperclip/skills-sync.sh >> /home/paperclip/skills-sync.log 2>&1
set -u
HOME_DIR=${HOME_DIR:-/home/paperclip}
CORE="build env figma memory pc-lite qa review scope"
STORE="$HOME_DIR/.paperclip/instances/default/skills/${COMPANY_ID:-d255c3a4-2066-4d81-8c40-862ad8208963}"
DEST="$HOME_DIR/skills"
STATE="$HOME_DIR/.skills-synced.json"

is_core() { for c in $CORE; do [ "$1" = "$c" ] && return 0; done; return 1; }

[ -d "$STORE" ] || exit 0
mkdir -p "$DEST"

current=" "
changed=0
for d in "$STORE"/*/; do
  [ -f "${d}SKILL.md" ] || continue
  slug=$(basename "$d")
  # skip dotfiles, runtime caches (__runtime_cache_v1__) and anything not a plain slug
  case "$slug" in .*|__*) continue;; esac
  case "$slug" in *[!a-zA-Z0-9._-]*) continue;; esac
  is_core "$slug" && continue
  current="${current}${slug} "
  if ! cmp -s "${d}SKILL.md" "$DEST/$slug/SKILL.md"; then
    mkdir -p "$DEST/$slug"
    cp "${d}SKILL.md" "$DEST/$slug/SKILL.md"
    chmod 644 "$DEST/$slug/SKILL.md"
    echo "$(date +%Y-%m-%dT%H:%M:%S%z) synced $slug"
    changed=1
  fi
done

# remove only slugs this script previously synced that have since left the store
for slug in $(cat "$STATE" 2>/dev/null || true); do
  is_core "$slug" && continue
  case "$current" in *" $slug "*) continue;; esac
  rm -rf "$DEST/$slug"
  echo "$(date +%Y-%m-%dT%H:%M:%S%z) removed $slug (gone from store)"
  changed=1
done

printf '%s' "$current" > "$STATE"
exit $changed
