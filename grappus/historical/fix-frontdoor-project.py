#!/usr/bin/env python3
"""Front-door project routing is mandatory on the parent, not just the child.

Why: GRA-70 stayed projectId=null while child GRA-71 carried Ateam. Step -2
said "set projectId on child when known, else omit", so parent null looked
correct. Project assignment on parent is critical (board filter, vault scope).
Lock on chat_channel issues blocks only assigneeAgentId/terminal status;
PATCH projectId works (verified on GRA-70).

Fix: route BEFORE child creation, PATCH parent projectId, pass same id on
child explicitly, backfill parent from child when ambiguous. Idempotent
(marker frontdoor-project v1). Run on VPS as paperclip."""
import json, os, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
CL = "221ca6db-6cf1-49ff-bdf1-270a53c201f9"
MARK = "<!-- frontdoor-project v1 -->"


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


OLD_BULLET = "   - `projectId`: set it when your routing already knows the project; otherwise ask for project clarification on the child."

NEW_BULLET = """   - `projectId`: mandatory, same value you set on the parent in step 1b. Never omit it when you know the project. Only omit when genuinely ambiguous (then ask for project clarification on the child and backfill the parent on your next wake)."""

OLD_STEP1 = "1. Read the newest human message. Classify: pure product question, or work request (a bug, a feature, anything to change)."

NEW_STEP1 = """1. Read the newest human message. Classify: pure product question, or work request (a bug, a feature, anything to change).
1b. Route the PROJECT first — on the front-door parent itself, before creating the child. The Slack lock blocks only `assigneeAgentId` and terminal statuses; `PATCH {"projectId": ...}` on a `chat_channel` issue is allowed (verified). So: `GET /api/companies/{companyId}/projects`, match task text vs `name`/`description`. One clear match → `PATCH /api/issues/{frontDoorId}` with `{"projectId": "<id>", "comment": "Routed to project <name>: <one-line reason>"}`. Then read it: `GET /api/projects/{projectId}` — `description`, `goals`, `primaryWorkspace`/`workspaces` (repo paths), `codebase`, `env` — and use it in the child description. Ambiguous → leave parent null, omit `projectId` on the child, ask for project clarification on the child; on your next wake (`issue_children_completed` or next Slack turn) copy the child's `projectId` back onto the parent with the same PATCH. Do not create any interaction (`ask_user_questions`/`request_confirmation`) on the front-door issue to resolve ambiguity — route on the child path instead."""

path = f"/api/agents/{CL}/instructions-bundle/file?companyId={C}&path=AGENTS.md"
content = req("GET", path).get("content", "")
if MARK in content:
    print("Clarifier unchanged (already applied)")
else:
    new = content
    if OLD_STEP1 in new:
        new = new.replace(OLD_STEP1, NEW_STEP1, 1)
    else:
        print("  no anchor: step 1")
    if OLD_BULLET in new:
        new = new.replace(OLD_BULLET, NEW_BULLET, 1)
    else:
        print("  no anchor: projectId bullet")
    if "<!-- frontdoor-mode v1 -->" in new:
        new = new.replace("<!-- frontdoor-mode v1 -->", "<!-- frontdoor-mode v1 -->\n" + MARK, 1)
    if new != content:
        req("PUT", f"/api/agents/{CL}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new})
        print("Clarifier", "updated" if req("GET", path).get("content") == new else "PUT did not stick")
    else:
        print("Clarifier unchanged")
