#!/usr/bin/env python3
"""Add the "mention = wake" rule to every claude_local agent's AGENTS.md.

Why: Planner @mentioned Executor in its plan comment ("on accept I create the verification child") before the human
approved the plan. A mention wakes the agent for a full run, so Executor ran for ~2 min with nothing to do and it looked
like the plan gate had been skipped (GRA-41, 2026-09-25).

Every AGENTS.md edit resets that agent's task sessions (gotcha 15), so an agent is edited only when it has no live run.
Meant for cron (*/5) until every agent has the rule; then it removes its own crontab line. Idempotent.
Runs on the VPS as user paperclip."""
import json, os, subprocess, urllib.request

B = "http://127.0.0.1:3100"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"]["https://187.126.114.172.sslip.io"]["token"]
MARKER = "Mention = wake-up (mandatory)"
ANCHOR = "Never resolve an agent by searching; copy from this table."
RULE = f"""

**{MARKER}.** An `agent://` mention wakes that agent immediately for a full run. Mention an agent only in the same step where you assign it work or need its action now (handoff, review request, answer to its question). When you only refer to an agent — a future step, a plan item, who will do what after approval — write its name in plain text with no link."""


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))


live = {r.get("agentId") for r in req("GET", f"/api/companies/{C}/live-runs")}
pending = 0
for a in req("GET", f"/api/companies/{C}/agents"):
    if a.get("adapterType") != "claude_local":
        continue
    cur = req("GET", f"/api/agents/{a['id']}/instructions-bundle/file?path=AGENTS.md&companyId={C}")
    body = cur.get("content") or ""
    if MARKER in body:
        continue
    if a["id"] in live:
        pending += 1
        print(a["name"], "has a live run, retry later")
        continue
    new = body.replace(ANCHOR, ANCHOR + RULE, 1) if ANCHOR in body else body.rstrip("\n") + RULE + "\n"
    req("PUT", f"/api/agents/{a['id']}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new})
    print(a["name"], "rule added")

if pending == 0:
    tab = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
    if "add-mention-rule.py" in tab:
        subprocess.run(["crontab", "-"], input="".join(l + "\n" for l in tab.splitlines() if "add-mention-rule.py" not in l), text=True)
        print("all agents done, cron entry removed")
