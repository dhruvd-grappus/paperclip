#!/usr/bin/env python3
"""Hire HygieneAgent (process adapter, hourly timer) if missing, then run one heartbeat and print the report head.
Runs on the VPS as user paperclip."""
import json, os, sys, time, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


agents = {a["name"]: a for a in req("GET", f"/api/companies/{C}/agents")}
cfg = {"command": "node", "args": ["/home/paperclip/agents/hygiene/index.js"], "cwd": "/home/paperclip/agents/hygiene", "timeoutSec": 180,
       "env": {"HYGIENE_ISSUE_ID": "dc747dd3-0198-4444-aa49-9d0ab513c7e2", "HYGIENE_PUBLIC_HOST": "187.126.114.172.sslip.io", "HYGIENE_HOST_BACKUP_DIR": "/var/backups/paperclip", "HYGIENE_WORKTREES_DIR": "/home/paperclip/worktrees"}}
runtime = {"heartbeat": {"enabled": False, "wakeOnDemand": True}}  # scheduled by cron with issueId (see run-hourly.sh)
if "HygieneAgent" not in agents:
    body = {"name": "HygieneAgent", "role": "devops", "title": "Hygiene & Health (deterministic)", "icon": "shield",
            "reportsTo": agents["Planner"]["id"],
            "capabilities": "Hourly deterministic checks: server and host health, backups, disk, TLS, agent run failures and budgets, stale/blocked/waiting issues, cycle time and review bounce loops, chat endpoint status. Writes a report to the standing 'Hygiene report' issue.",
            "adapterType": "process", "adapterConfig": cfg, "runtimeConfig": runtime, "budgetMonthlyCents": 0}
    r = req("POST", f"/api/companies/{C}/agent-hires", body)
    a = r.get("agent", r); print("hired", a["id"], a["status"])
    if r.get("approval"):
        req("POST", f"/api/approvals/{r['approval']['id']}/approve", {"decisionNote": "Board-created hygiene agent; hourly timer justified: periodic health checks"}); print("approved")
    agents["HygieneAgent"] = a
else:
    a = agents["HygieneAgent"]
    old = a.get("adapterConfig") or {}
    merged = {**old, **cfg, "env": {**(old.get("env") or {}), **cfg["env"]}}
    if os.environ.get("TYPESAFE_API_KEY"):
        merged["env"]["TYPESAFE_API_KEY"] = os.environ["TYPESAFE_API_KEY"]
    req("PATCH", f"/api/agents/{a['id']}", {"adapterConfig": merged, "runtimeConfig": runtime}); print("updated")
HID = agents["HygieneAgent"]["id"]
if "--no-run" in sys.argv:
    sys.exit(0)
hi = req("GET", "/api/issues/dc747dd3-0198-4444-aa49-9d0ab513c7e2")  # standing GRA-23
req("POST", f"/api/agents/{HID}/heartbeat/invoke", {"issueId": hi["id"]})
r0 = {}
for _ in range(40):
    time.sleep(4)
    rs = req("GET", f"/api/companies/{C}/heartbeat-runs?agentId={HID}"); rs = rs if isinstance(rs, list) else rs.get("runs", [])
    r0 = rs[0] if rs else {}
    if r0.get("status") not in ("queued", "running"):
        break
print("run", r0.get("status"), "err", r0.get("error") or r0.get("errorCode") or "")
print("stderr", (r0.get("stderr") or "")[-600:])
if hi:
    d = req("GET", f"/api/issues/{hi['id']}/documents/latest")
    print(hi["identifier"], "priority", req("GET", f"/api/issues/{hi['id']}")["priority"])
    print((d.get("body") or "")[:2500])
