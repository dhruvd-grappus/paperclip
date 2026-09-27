"""Read-only: validate the bridge's Slack bot token with auth.test. Never prints the token."""
import json, os, urllib.request
tok = None
for line in open(os.path.expanduser("~/slack-bridge/.env")):
    if line.strip().startswith("SLACK_BOT_TOKEN="):
        tok = line.split("=", 1)[1].strip().strip('"')
print("token present:", bool(tok), "| prefix ok:", bool(tok and tok.startswith("xoxb-")))
r = urllib.request.Request("https://slack.com/api/auth.test", method="POST", headers={"Authorization": "Bearer " + (tok or "")})
with urllib.request.urlopen(r, timeout=20) as resp:
    out = json.loads(resp.read())
    scopes = resp.headers.get("x-oauth-scopes", "")
print("ok:", out.get("ok"), "| team:", out.get("team"), "| bot user:", out.get("user"), "| error:", out.get("error"))
print("has chat:write:", "chat:write" in scopes.split(","))
