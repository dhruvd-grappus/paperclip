#!/usr/bin/env python3
"""Front-door mode for Slack issues.

Why: Paperclip binds every inbound Slack turn to its issue via a `chat_conversations` row, and then refuses
any `assigneeAgentId` change on that issue (services/issues.js "chat_binding_agent_locked", returned as HTTP 200
with an `error` body). So Clarifier can never hand a Slack issue to ProductGuide, Planner or
Executor on the same issue: every `chat_channel` issue stayed parked on Clarifier while every `manual` issue
flowed through the pipeline. A mention/child wake also cannot publish to Slack (publication needs the
conversation agent's chat-rooted run), so results return to the thread on the requester's next message.

Fix: a Slack issue is only the handset. Clarifier keeps it forever and routes by creating a child issue
(`parentId` = the Slack issue, no chat binding -> fully assignable) for the real pipeline. On
`issue_children_completed` it writes the result summary on the Slack issue; the next Slack turn carries it out.

Patches Clarifier (front-door procedure before scoping) and ProductGuide (no reassign; the parent wakes
Clarifier). Idempotent. Run on the VPS as user paperclip."""
import json, os, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
MARK = "<!-- frontdoor-mode v1 -->"
PG_MARK = "<!-- frontdoor-handoff v1 -->"


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


agents = {a["name"]: a for a in req("GET", f"/api/companies/{C}/agents")}
CL, PG = agents["Clarifier"]["id"], agents["ProductGuide"]["id"]

CL_SECTION = f"""{MARK}
## Step -2: front-door issues (Slack) — delegate to a child, never reassign

A Slack-originated issue is the front door. You can tell: `GET /api/issues/{{id}}` shows `originKind` `chat_channel` (or the run context `source` starts with `chat:`). Paperclip binds it to the Slack thread and **refuses `assigneeAgentId` changes on it** — the API answers HTTP 200 with a body `{{"error":"Agent assignment cannot change while this task is bound to an external channel"}}`. Never PATCH `assigneeAgentId` on a front-door issue and never set it `done` or `cancelled`. If you get that error, do not retry and do not ask the human to reassign: switch to this step.

The front-door issue is only the handset. All work goes to a child issue, which is a normal issue and fully assignable:

1. Read the newest human message. Classify: pure product question, or work request (a bug, a feature, anything to change).
2. `POST /api/companies/{C}/issues` with:
   - `title`: one line, the requester's ask in their words.
   - `description`: the requester's exact message plus the Slack link, and anything the vault already told you.
   - `parentId`: the front-door issue id.
   - `status`: `todo`.
   - `assigneeAgentId`: ProductGuide (`{PG}`) for a pure product question; Clarifier (`{CL}`) for a work request.
   - `projectId`: set it when your routing already knows the project; otherwise ask for project clarification on the child.
   - `idempotencyKey`: `frontdoor:<frontDoorIssueId>:<newestCommentId>`.
3. `PATCH /api/issues/{{id}}` on the front-door issue with only a `comment` (no assignee, no terminal status): one line naming the child identifier and that work is tracked there. This is the reply the requester sees in Slack. Never offer the requester a routing choice; routing is yours.
4. End the heartbeat. Do not poll the child.

A product question follows this step, **not** the assignee PATCH in Step -1 (that PATCH fails here). Everything after the child exists is Step 0 onward, but on the child, not on the front door: you scope the child and hand it to Planner for the normal pipeline.

When the child tree finishes, Paperclip wakes you on the front-door issue (`issue_children_completed`). Do not reassign anything. Read the finished child, then post the result as a colleague-facing summary in a comment on the front-door issue (plain language, link the child). The requester's next Slack message is what carries it into the thread, so also state anything still open. Then end.

"""

path = f"/api/agents/{CL}/instructions-bundle/file?companyId={C}&path=AGENTS.md"
cl = req("GET", path).get("content", "")
new = cl
if MARK not in new:
    anchor = "<!-- question-route v1 -->" if "<!-- question-route v1 -->" in new else "## Hard boundaries"
    if anchor in new:
        new = new.replace(anchor, CL_SECTION + anchor, 1)
    else:
        print("  clarifier: no anchor for the front-door section")
if new != cl:
    req("PUT", f"/api/agents/{CL}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new})
    print("Clarifier", "updated" if req("GET", path).get("content") == new else "PUT did not stick")
else:
    print("Clarifier unchanged")

pgpath = f"/api/agents/{PG}/instructions-bundle/file?companyId={C}&path=AGENTS.md"
pg = req("GET", pgpath).get("content", "")
tw = pg
if PG_MARK not in tw:
    old = ("If the message asks for something to be built, changed or fixed: `PATCH /api/issues/{id}` with "
           "`{\"assigneeAgentId\": \"" + CL + "\", \"status\": \"todo\", \"comment\": \"This is a change request, not a question. Sending to Clarifier.\"}` and end.")
    newblock = (PG_MARK + "\n"
                "If the message asks for something to be built, changed or fixed, you cannot hand it back by reassigning: the "
                "issue may be Slack-bound and Paperclip refuses `assigneeAgentId` changes there (HTTP 200 with "
                "`\"Agent assignment cannot change while this task is bound to an external channel\"`). Do not retry that PATCH. "
                "Instead `PATCH /api/issues/{id}` with `{\"status\": \"done\", \"comment\": \"This is a change request, not a question. "
                "Escalating: the tracking issue wakes Clarifier, who re-routes it.\"}` and end. Completing your task wakes Clarifier, "
                "who re-routes the request.")
    if old in tw:
        tw = tw.replace(old, newblock, 1)
    elif "## Handoff" in tw:
        tw = tw.replace("## Handoff", "## Handoff\n" + newblock.split("\n", 1)[1], 1)
    else:
        print("  productguide: no handoff anchor found")
if tw != pg:
    req("PUT", f"/api/agents/{PG}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": tw})
    print("ProductGuide", "updated" if req("GET", pgpath).get("content") == tw else "PUT did not stick")
else:
    print("ProductGuide unchanged")
