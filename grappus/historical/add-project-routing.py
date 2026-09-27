#!/usr/bin/env python3
"""Append project-routing instructions to every agent's AGENTS.md on the hosted instance and set cwd.
Runs on the VPS as user paperclip (reads board token from ~/.paperclip/auth.json)."""
import json, os, sys, urllib.request, urllib.parse

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
WS = "/home/paperclip/workspace"


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


CLARIFIER = """## Project routing (mandatory, before anything else)

Every issue must belong to a Paperclip project. You are responsible for placing it.

1. `GET /api/issues/{id}` and read `projectId` and `project`. If set, skip to step 4.
2. If `projectId` is null: `GET /api/companies/{companyId}/projects`. Match the task text against each project's `name` and `description`.
   - One clear match: `PATCH /api/issues/{id}` with `{"projectId": "<id>", "comment": "Routed to project <name>: <one-line reason>"}`.
   - Ambiguous or no match: create an `ask_user_questions` interaction with a single-select of the project names plus "New project". Set the issue `in_review`, comment what you are waiting on, end the heartbeat. On answer, patch `projectId`; for "New project" hand the issue to Planner with a comment asking Planner to create the project first.
3. Never write a Scope for an issue that has no `projectId`.
4. Read the project: `GET /api/projects/{projectId}` (description, goals, `primaryWorkspace` and `workspaces` = repo paths, `codebase`, `env`, `leadAgentId`), plus its issues `GET /api/companies/{companyId}/issues?projectId=<id>` for recent related work. Put a "Project" line at the top of the Scope: name, goal, workspace path.
5. Child issues you or Planner create inherit `projectId` from the parent. Always pass it explicitly.
"""

OTHERS = """## Project context (mandatory)

Every issue you touch must have a `projectId`. Read `GET /api/issues/{id}`; use `project` (description, goals) and `GET /api/projects/{projectId}` (`primaryWorkspace` / `workspaces` = the repo paths you work in, `codebase`, `env`) before acting. If `projectId` is null, reassign the issue to Clarifier with the comment "Needs project routing" and end the heartbeat. Any child issue you create carries the parent's `projectId`.
"""

agents = {a["name"]: a for a in req("GET", f"/api/companies/{C}/agents")}
for name, a in agents.items():
    aid = a["id"]
    cur = req("GET", f"/api/agents/{aid}/instructions-bundle/file?path=AGENTS.md&companyId={C}")
    body = cur.get("content") or cur.get("body") or ""
    add = CLARIFIER if name == "Clarifier" else OTHERS
    if "(mandatory" in body:
        print(name, "already has section")
    else:
        marker = "## Operating workflow"
        new = body.replace(marker, add + "\n" + marker, 1) if marker in body else body + "\n" + add
        req("PUT", f"/api/agents/{aid}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new})
        print(name, "instructions updated")
    cfg = dict(a.get("adapterConfig") or {})
    if cfg.get("cwd") != WS:
        cfg["cwd"] = WS
        req("PATCH", f"/api/agents/{aid}", {"adapterConfig": cfg})
        print(name, "cwd set")
