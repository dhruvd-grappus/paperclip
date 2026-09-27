#!/usr/bin/env python3
"""Paste exact interaction payloads into agent instructions so agents never look them up at runtime.
Clarifier: ask_user_questions. Planner: request_confirmation + ask_user_questions. All: document PUT with baseRevisionId.
Idempotent. Runs on the VPS as user paperclip."""
import json, os, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))


ASK = '''## Payload: ask_user_questions (copy exactly, do not look it up)

`POST /api/issues/{issueId}/interactions` with headers `Authorization: Bearer $PAPERCLIP_API_KEY`, `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`, `Content-Type: application/json`. Batch all questions into one card. Each question needs `id`, `prompt`, `selectionMode` (`single` | `multi`), and at least one option with `id` and `label`. Free text = one option with `"freeText": true`. Never send `type: "text"` or an empty options array.

```json
{
  "kind": "ask_user_questions",
  "idempotencyKey": "questions:{issueId}:scope:v1",
  "title": "<short title, e.g. Dark mode: 3 questions before planning>",
  "resolverPolicy": "human_only",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "questions": [
      { "id": "q1", "prompt": "<question>", "selectionMode": "single", "required": true, "allowOther": true,
        "options": [ { "id": "a", "label": "<option A>", "description": "<one line>" }, { "id": "b", "label": "<option B>" } ] },
      { "id": "q2", "prompt": "<open question>", "selectionMode": "single", "required": true,
        "options": [ { "id": "describe", "label": "I'll describe it", "freeText": true } ] }
    ]
  }
}
```

Then, in the same heartbeat: `PATCH /api/issues/{issueId}` with `{"status": "in_review", "comment": "Waiting for your answers in the question card."}` and end. Bump `v1` → `v2` when asking a second round. When woken by the answer, read it from `GET /api/issues/{issueId}/interactions` (the resolved interaction's `response`), do not re-ask.
'''

CONFIRM = '''## Payload: request_confirmation (copy exactly, do not look it up)

Human gate. `POST /api/issues/{issueId}/interactions` with the run headers. Update the target document first, then create the card against its latest revision (`GET /api/issues/{issueId}/documents/{key}` → `latestRevisionId`, `revisionNumber`).

```json
{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{issueId}:plan:{latestRevisionId}",
  "title": "Plan approval",
  "resolverPolicy": "human_only",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Accept this plan?",
    "acceptLabel": "Accept plan",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What needs to change?",
    "detailsMarkdown": "<3-6 line summary of the plan: what, repo radius, risks>",
    "supersedeOnUserComment": true,
    "target": { "type": "issue_document", "issueId": "{issueId}", "documentId": "{documentId}", "key": "plan", "revisionId": "{latestRevisionId}", "revisionNumber": 3 }
  }
}
```

For the link gate use title `Review link`, key `plan` target still, prompt `Does the result work for you?`, acceptLabel `Accept`, rejectLabel `Request changes`. After creating: `PATCH /api/issues/{issueId}` `{"status": "in_review", "comment": "Waiting for your decision on the card."}` and end. Rejection wakes you with the reason in the interaction `response`.
'''

DOCS = '''## Payload: documents (copy exactly)

Create or update: `PUT /api/issues/{issueId}/documents/{key}` with `{"title": "...", "format": "markdown", "body": "..."}`. Updating an existing document REQUIRES `baseRevisionId`: first `GET` it, take `latestRevisionId`, then PUT `{"title", "format", "body", "baseRevisionId": "<latestRevisionId>"}`. A 409 means someone edited it since; GET again and merge. Keys used here: `scope`, `plan` on task issues; `goals`, `conventions`, `repo-radius`, `history`, `decisions` on vault issues.
'''

agents = {a["name"]: a for a in req("GET", f"/api/companies/{C}/agents")}
plan = {"Clarifier": [ASK, DOCS], "Planner": [CONFIRM, ASK, DOCS], "Executor": [DOCS], "QA": [DOCS], "CodeReviewer": [DOCS]}
for name, blocks in plan.items():
    a = agents.get(name)
    if not a:
        continue
    cur = req("GET", f"/api/agents/{a['id']}/instructions-bundle/file?path=AGENTS.md&companyId={C}")
    body = cur.get("content") or ""
    changed = False
    for blk in blocks:
        head = blk.split("\n", 1)[0]
        if head in body:
            continue
        body = body.rstrip() + "\n\n" + blk
        changed = True
    if changed:
        req("PUT", f"/api/agents/{a['id']}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": body})
    print(name, "updated" if changed else "already had payloads")
