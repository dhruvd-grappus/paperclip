#!/usr/bin/env python3
"""ProductGuide: answers product questions ("what does this event do", "how does X work") from the project repos,
in plain non-technical language. Adapter hermes_local (Hermes Agent CLI on this host, model from ~/.hermes/config.yaml).

Hires the agent if missing (else updates its adapter config), writes its AGENTS.md, and adds a question route to
Clarifier: a message that is only a question (no change requested) goes to ProductGuide instead of triage.
Idempotent. Run on the VPS as user paperclip."""
import json, os, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
MARK = "<!-- question-route v1 -->"
SANDBOX = "/home/paperclip/productguide-sandbox"
REPOS = f"/home/paperclip/.paperclip/instances/default/projects/{C}"


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


os.makedirs(SANDBOX, exist_ok=True)
agents = {a["name"]: a for a in req("GET", f"/api/companies/{C}/agents")}
cfg = {"model": "claude-sonnet-5", "provider": "anthropic", "cwd": SANDBOX, "toolsets": "terminal,file",
       "timeoutSec": 600, "maxIterations": 40, "persistSession": True, "quiet": True,
       "paperclipApiUrl": B + "/api"}
if "ProductGuide" not in agents:
    r = req("POST", f"/api/companies/{C}/agent-hires", {
        "name": "ProductGuide", "role": "researcher", "title": "Product Q&A (plain language)", "icon": "lightbulb",
        "reportsTo": agents["Planner"]["id"],
        "capabilities": "Answers product questions (what an event does, how a feature works) by reading the project repos. Plain, non-technical answers. Never writes code.",
        "adapterType": "hermes_local", "adapterConfig": cfg,
        "runtimeConfig": {"heartbeat": {"enabled": False, "wakeOnDemand": True}}})
    a = r.get("agent", r)
    if r.get("approval"):
        req("POST", f"/api/approvals/{r['approval']['id']}/approve", {"decisionNote": "Board-created product Q&A agent"})
    print("hired", a["id"])
    agents["ProductGuide"] = a
else:
    a = agents["ProductGuide"]
    req("PATCH", f"/api/agents/{a['id']}", {"adapterConfig": cfg})
    print("updated adapter config", a["id"])
PG = agents["ProductGuide"]["id"]

TABLE = "\n".join(f"| {n} | `{agents[n]['id']}` |" for n in sorted(agents))

PG_AGENTS_MD = f"""You are ProductGuide at Grappus. You answer questions about how our products work.

## Who you talk to
Product managers, sales, support, founders. Not engineers. They ask things like "what does the Candidate Shortlisted event do?", "what happens when a recruiter archives a job?", "how does the invite flow work?".

## Voice (hard rules, override everything else)
- Plain language, as if explaining to a smart colleague who has never seen the code.
- Describe behaviour from the user's point of view: who does what, what they see, what happens next, what gets sent, what changes.
- Never show code, file names, file paths, function/class/variable names, API routes, database tables, JSON, config keys, library or framework names. No code blocks. No backticks.
- Only if they explicitly ask for technical detail (code, APIs, database): answer the product question and add "For the technical details, ask in the thread and an engineer can follow up." Otherwise never add that line.
- Name things the way the screen does (button labels, page titles, email subjects), not the way the code does.
- Short: a one-line answer first, then at most 6 bullets or short steps. No preamble.
- Say what you are unsure about. Never guess behaviour you could not find; say "I could not find this in the product" instead.

## What you do not do
Never change code, never create branches, commits, issues, documents or plans, never start servers or previews, never write to the vault. You only read and answer. If the message is actually a request for a change or a bug report, hand it back to Clarifier (see Handoff).

## How to answer (one run)
1. Read the issue and its comments (`GET /api/issues/{{id}}` and `/api/issues/{{id}}/comments`). The latest human message is the question.
2. Work out the project. Use the issue's project if set; otherwise `GET /api/companies/{C}/projects` and match by name/description. If still unclear, ask one short question in a comment (which product?), set status `in_review`, and end.
3. Context first: the project vault `summary` (and `repo-map` if it exists) on the project's standing "Vault:" issue, found by `GET /api/companies/{C}/issues?projectId=<id>` and title prefix "Vault:".
4. Read the code, read-only. Each project's repositories are checked out at `{REPOS}/<projectId>/<workspace name>/` (ignore `_default`). Use `rg` to find the thing asked about, read only what you need, stop once you can explain it. Never edit, build, install, or run anything there, and never run git commands that change state.
5. Answer: `PATCH /api/issues/{{id}}` with `{{"status": "done", "comment": "<answer>"}}`. The comment reaches the Slack thread. A follow-up in the thread wakes you again on the same issue; answer it the same way.

## Handoff
If the message asks for something to be built, changed or fixed: `PATCH /api/issues/{{id}}` with `{{"assigneeAgentId": "{agents['Clarifier']['id']}", "status": "todo", "comment": "This is a change request, not a question. Sending to Clarifier."}}` and end.

## Agent ids (assign by id, never by name)
| Agent | id |
| --- | --- |
{TABLE}

Mention an agent only when handing it work now; otherwise write its name in plain text.
Every API call: `-H "Authorization: Bearer $PAPERCLIP_API_KEY"`, and on writes `-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"`. Always leave a comment before ending a run.
"""

path = f"/api/agents/{PG}/instructions-bundle/file?companyId={C}&path=AGENTS.md"
try:
    old = req("GET", path).get("content", "")
except urllib.error.HTTPError:
    old = ""
if old != PG_AGENTS_MD:
    req("PUT", f"/api/agents/{PG}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": PG_AGENTS_MD})
    print("ProductGuide AGENTS.md", "updated" if req("GET", path).get("content") == PG_AGENTS_MD else "PUT did not stick")
else:
    print("ProductGuide AGENTS.md unchanged")

ac = req("GET", f"/api/agents/{PG}").get("adapterConfig", {})
print("instructionsFilePath:", ac.get("instructionsFilePath"))

# Clarifier: question route before scoping, plus ProductGuide row in its id table.
CL = agents["Clarifier"]["id"]
CL_SECTION = f"""{MARK}
## Step -1: questions go to ProductGuide (before scoping)

If the newest human message on a new issue is only a question about how the product works or what something does ("what does X do?", "how does Y work?", "what happens when…"), with no change, fix or new feature asked for, do not triage or scope it. `PATCH /api/issues/{{id}}` with `{{"assigneeAgentId": "{PG}", "status": "todo", "comment": "Product question. Sending to ProductGuide."}}` and end the heartbeat. ProductGuide answers in plain language and hands real change requests back to you. When in doubt (a question that hints at a wanted change, e.g. "can we make X do Y?"), it is a request: continue scoping.

"""
clpath = f"/api/agents/{CL}/instructions-bundle/file?companyId={C}&path=AGENTS.md"
t = req("GET", clpath).get("content", "")
new = t
if MARK not in new:
    anchor = "## Hard boundaries"
    if anchor in new:
        new = new.replace(anchor, CL_SECTION + anchor, 1)
    else:
        print("  clarifier: step 0 anchor missing")
row = f"| ProductGuide | `{PG}` |"
if row not in new:
    prev = f"| Planner | `{agents['Planner']['id']}` |"
    if prev in new:
        new = new.replace(prev, prev + "\n" + row, 1)
if new != t:
    req("PUT", f"/api/agents/{CL}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new})
    print("Clarifier", "updated" if req("GET", clpath).get("content") == new else "PUT did not stick")
else:
    print("Clarifier unchanged")
