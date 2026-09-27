#!/usr/bin/env bash
# Paperclip-native company export -> /home/paperclip/backups/export-<ts>.json
#
# This is the "Company Export" the UI offers, driven from cron so it is not a
# manual step. It captures everything the export schema knows about: company,
# agents (+ instructions bundles), skills, projects, issues, issue documents,
# work products and attachments.
#
# It is NOT a full backup on its own: approvals, cost events and the activity
# log are excluded by the export (see /export/fidelity warnings). The pg_dump in
# /usr/local/bin/paperclip-backup remains the authoritative database backup.
#
# Run as: paperclip (needs the board token in ~/.paperclip/auth.json).
set -euo pipefail
export HOME=/home/paperclip

COMPANY=${COMPANY:-d255c3a4-2066-4d81-8c40-862ad8208963}
BASE=${PAPERCLIP_BASE_URL:-http://127.0.0.1:3100}
AUTH_HOST=${PAPERCLIP_AUTH_HOST:-https://187.126.114.172.sslip.io}
OUT=${PAPERCLIP_EXPORT_DIR:-$HOME/backups}
KEEP=${KEEP:-14}

mkdir -p "$OUT"
TS=$(date +%Y%m%d-%H%M%S)
TOK=$(jq -r --arg h "$AUTH_HOST" '.credentials[$h].token // empty' "$HOME/.paperclip/auth.json")
if [ -z "$TOK" ]; then
  echo "no board token for $AUTH_HOST in ~/.paperclip/auth.json" >&2
  exit 1
fi

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
printf '%s' '{"include":{"company":true,"agents":true,"projects":true,"issues":true,"skills":true},"expandReferencedSkills":true}' > "$BODY"

curl -sS --fail-with-body -m 900 -X POST \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  --data-binary @"$BODY" \
  "$BASE/api/companies/$COMPANY/export" \
  -o "$OUT/export-$TS.json"

curl -sS --fail-with-body -m 120 \
  -H "Authorization: Bearer $TOK" \
  "$BASE/api/companies/$COMPANY/export/fidelity" \
  -o "$OUT/fidelity-$TS.json"

ln -sfn "export-$TS.json" "$OUT/export-latest.json"
ln -sfn "fidelity-$TS.json" "$OUT/fidelity-latest.json"

ls -1t "$OUT"/export-*.json 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "$OUT"/fidelity-*.json 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

jq -r --arg ts "$TS" '"export \($ts): files=\(.files|length) agents=\(.manifest.agents|length) skills=\(.manifest.skills|length) projects=\(.manifest.projects|length) issues=\(.manifest.issues|length) docs=\([.manifest.issues[].documents[]?]|length)"' "$OUT/export-$TS.json"
