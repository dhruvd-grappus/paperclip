#!/usr/bin/env python3
"""Efficiency fixes. Idempotent. Runs on the VPS as user paperclip.
2. Pin the agent-id table into every claude_local agent (mentions resolve by id, never by name).
6. Drop the agent-level workspaceStrategy on Executor/QA/CodeReviewer: the project executionWorkspacePolicy is the
   single source, so the workspace fingerprint stops flapping between runs (usage_json showed
   "execution workspace configuration changed: workspace strategy, workspace lifecycle commands" on every run)."""
import json, os, re, urllib.request
B = "https://187.126.114.172.sslip.io"; C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))
ag = req("GET", f"/api/companies/{C}/agents")
live = [a for a in ag if a.get("status") not in ("terminated",)]
table = "\n".join(f"| {a['name']} | `{a['id']}` |" for a in sorted(live, key=lambda a: a["name"]))
SECTION = f"""## Agent ids (mandatory: mention and assign by id, never by name)

| Agent | id |
| --- | --- |
{table}

Use the id in `assigneeAgentId` and in mentions. A wrong or name-only mention wakes the wrong agent for a full run. Never resolve an agent by searching; copy from this table.
"""
for a in ag:
    if a["adapterType"] != "claude_local": continue
    cur = req("GET", f"/api/agents/{a['id']}/instructions-bundle/file?path=AGENTS.md&companyId={C}")["content"]
    new = re.sub(r"## Agent ids \(mandatory[^\n]*\n.*?(?=\n## )", SECTION.rstrip("\n"), cur, count=1, flags=re.S) if "## Agent ids (mandatory" in cur else cur.replace("## Role charter", SECTION + "\n## Role charter", 1)
    if new != cur:
        req("PUT", f"/api/agents/{a['id']}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new}); print("ids pinned:", a["name"])
    if a["name"] in ("Executor", "QA", "CodeReviewer"):
        cfg = dict(a.get("adapterConfig") or {})
        if cfg.get("workspaceStrategy") is not None:
            # PATCH merges top-level adapterConfig keys; a key is removed only by sending null
            req("PATCH", f"/api/agents/{a['id']}", {"adapterConfig": {"workspaceStrategy": None}})
            after = req("GET", f"/api/agents/{a['id']}").get("adapterConfig") or {}
            print("agent workspaceStrategy removed:", a["name"], "| still present" if after.get("workspaceStrategy") else "| verified gone")
for p in req("GET", f"/api/companies/{C}/projects"):
    pol = p.get("executionWorkspacePolicy") or {}
    print("project", p["name"], "strategy:", (pol.get("workspaceStrategy") or {}).get("type"), "provision:", bool((pol.get("workspaceStrategy") or {}).get("provisionCommand")))
