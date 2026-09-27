#!/bin/bash
# native-token.sh: keep CLAUDE_CODE_OAUTH_TOKEN on native (paperclip_runner) agents in sync with the host
# Claude login. Native runs get an isolated HOME with no credentials, so the token has to travel in adapterConfig.env.
# Refresh: a cheap `claude -p` as user paperclip renews ~/.claude/.credentials.json when it is near expiry (Claude Code
# refreshes on use; nothing else does once no legacy claude_local run happens). Then PATCH the agents only when the
# token changed (a PATCH resets task sessions). Cron: */10 * * * * /home/paperclip/native-token.sh <agentId> [<agentId>...]
# A long-lived token from `claude setup-token` (1 year) makes the refresh step unnecessary; put it into
# /home/paperclip/.claude/setup-token and it wins over the OAuth access token.
set -euo pipefail
export HOME=/home/paperclip
TOK=$(jq -r '.credentials["https://187.126.114.172.sslip.io"].token' ~/.paperclip/auth.json)
STATE=~/.native-token.sha
if [ -f ~/.claude/setup-token ]; then
  AT=$(tr -d '\n' < ~/.claude/setup-token)
else
  CRED=~/.claude/.credentials.json
  EXP=$(jq -r '.claudeAiOauth.expiresAt // 0' $CRED)
  NOW=$(( $(date +%s) * 1000 ))
  # A native run keeps the token it started with for up to timeoutSec (25 min) and cannot refresh it, so
  # never hand out a token with less than MIN_LEFT_MIN minutes left (GRA-227/231, 2026-09-27: synced with
  # 25 min left, died "ACP agent reported a terminal access failure"). `claude -p` alone does not help:
  # the CLI refreshes only once the token is (nearly) expired. So mark the cached token expired and let the
  # CLI run its normal refresh (same path as a real expiry), then verify; restore the file if it failed.
  # Refreshing revokes the previous access token at once (GRA-227/231 kept working 5 min past the nominal
  # expiry and died 1 s after the 16:00:10 refresh), so only refresh while no agent run is live; with runs
  # live, wait for the next tick (cron every 10 min).
  MIN_LEFT_MIN=${MIN_LEFT_MIN:-90}
  LIVE=$(curl -s -H "Authorization: Bearer $TOK" "https://187.126.114.172.sslip.io/api/companies/d255c3a4-2066-4d81-8c40-862ad8208963/live-runs" | jq 'length' 2>/dev/null || echo 1)
  if [ "$EXP" -lt $((NOW + MIN_LEFT_MIN*60*1000)) ] && [ "$LIVE" != 0 ]; then
    echo "$(date -Is) token has $(( (EXP - NOW) / 60000 )) min left; $LIVE live run(s), refresh deferred"
  elif [ "$EXP" -lt $((NOW + MIN_LEFT_MIN*60*1000)) ]; then
    cp -p $CRED $CRED.pre-refresh
    jq '.claudeAiOauth.expiresAt = 0' $CRED.pre-refresh > $CRED.tmp && chmod 600 $CRED.tmp && mv $CRED.tmp $CRED
    timeout 120 claude -p "reply with ok" --model claude-haiku-4-5-20251001 --max-turns 1 >/dev/null 2>&1 || true
    NEWEXP=$(jq -r '.claudeAiOauth.expiresAt // 0' $CRED)
    if [ "$NEWEXP" -lt $(( $(( $(date +%s) * 1000 )) + MIN_LEFT_MIN*60*1000 )) ]; then
      [ "$NEWEXP" = 0 ] && cp -p $CRED.pre-refresh $CRED
      echo "$(date -Is) WARN refresh failed; token has $(( (EXP - NOW) / 60000 )) min left"
    else
      echo "$(date -Is) refreshed; token valid $(( (NEWEXP - $(( $(date +%s) * 1000 ))) / 60000 )) min"
    fi
    rm -f $CRED.pre-refresh
  fi
  AT=$(jq -r .claudeAiOauth.accessToken $CRED)
fi
[ -n "$AT" ] && [ "$AT" != "null" ] || { echo "no token"; exit 1; }
SHA=$(printf %s "$AT" | sha256sum | cut -c1-16)
if [ -f "$STATE" ] && [ "$(cat $STATE)" = "$SHA" ] && [ "${FORCE:-}" != "1" ]; then exit 0; fi
for AGENT in "$@"; do
  jq -n --arg t "$AT" '{adapterConfig:{env:{CLAUDE_CODE_OAUTH_TOKEN:$t}}}' > /tmp/native-token.$$.json
  OUT=$(curl -s -X PATCH -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" --data-binary @/tmp/native-token.$$.json "https://187.126.114.172.sslip.io/api/agents/$AGENT")
  echo "$(date -Is) $AGENT $(echo "$OUT" | jq -r '.adapterConfig.env | keys | join(",")' 2>/dev/null || echo "$OUT" | head -c 200)"
  rm -f /tmp/native-token.$$.json
done
echo "$SHA" > "$STATE"
