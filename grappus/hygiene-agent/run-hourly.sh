#!/usr/bin/env bash
# Render the hygiene page. Cron (paperclip user): */15 * * * * /home/paperclip/agents/hygiene/run-hourly.sh
set -euo pipefail
cd /home/paperclip/agents/hygiene
export HYGIENE_OUT=/home/paperclip/hygiene-site
export TYPESAFE_API_KEY="$(cat /home/paperclip/.typesafe_key 2>/dev/null || true)"
node index.js
