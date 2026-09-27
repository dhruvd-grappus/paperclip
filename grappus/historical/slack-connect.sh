#!/usr/bin/env bash
# Configure the built-in Paperclip Slack chat endpoint (assigned agent: Clarifier).
# Required env: SLACK_BOT_TOKEN (xoxb-...), SLACK_SIGNING_SECRET
set -euo pipefail
B="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
E="0beac2ab-c6f8-48a0-a259-aed4c4c07edf"
: "${SLACK_BOT_TOKEN:?}"; : "${SLACK_SIGNING_SECRET:?}"
curl -sS -X POST "$B/api/chat-endpoints/$E/setup" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os; print(json.dumps({"action":"configure","credentials":{"botToken":os.environ["SLACK_BOT_TOKEN"],"signingSecret":os.environ["SLACK_SIGNING_SECRET"]}}))')"; echo
curl -sS -X POST "$B/api/chat-endpoints/$E/setup" -H 'Content-Type: application/json' -d '{"action":"verify"}'; echo
curl -sS -X POST "$B/api/chat-endpoints/$E/test"; echo
curl -sS "$B/api/chat-endpoints/$E" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("status:",d["status"]); print("setup:",json.dumps(d["setup"],indent=1))'
