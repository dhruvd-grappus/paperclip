#!/usr/bin/env python3
"""Tighten Clarifier's Slack front-door prose.

Why: on the routing turn Clarifier emitted a product opinion
("One thing worth confirming … analytics vs backend event") plus a follow-up
`ask_user_questions` card, and on the child-completion turn its answer comment
stayed internal while only the question card reached Slack (GRA-62/GRA-63).
Clarifier is a router/scope agent here: the routing reply must be one line and
the result turn must be the answer and nothing else, with no interaction.

This only edits Clarifier's instructions-bundle AGENTS.md. Idempotent (marker
`frontdoor-prose v1`). Run on the VPS as user paperclip.

NOTE: this does NOT make the child-completion answer reach Slack. That wake
(`issue.children_completed`) is not chat-origin, so Paperclip keeps its comment
internal; only a chat-origin run's final prose or an interaction publishes.
A board-side publisher (cron calling
POST /chat-endpoints/{ep}/conversations/{cv}/publications {commentId}) is still
required for delivery.
"""
import json, os, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
CL = "221ca6db-6cf1-49ff-bdf1-270a53c201f9"
MARK = "<!-- frontdoor-prose v1 -->"


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


OLD_ROUTE = ("3. `PATCH /api/issues/{id}` on the front-door issue with only a `comment` (no assignee, no terminal "
             "status): one line naming the child identifier and that work is tracked there. This is the reply the "
             "requester sees in Slack. Never offer the requester a routing choice; routing is yours.")

NEW_ROUTE = ("3. Reply with your **final response** — exactly one short line naming the child identifier and that the "
             "answer/work is tracked there (e.g. \"Routed to ProductGuide as GRA-63.\"). Nothing else: no product "
             "opinion, no \"one thing worth confirming\", no caveat, no offer to do more, no question. Do not create "
             "any interaction on the front-door issue, and do not also `PATCH` a separate progress comment — your "
             "final response is the reply the requester sees in Slack and is recorded automatically. Never offer the "
             "requester a routing choice; routing is yours.")

OLD_RESULT = ("When the child tree finishes, Paperclip wakes you on the front-door issue (`issue_children_completed`). "
              "Do not reassign anything. Read the finished child, then post the result as a colleague-facing summary "
              "in a comment on the front-door issue (plain language, link the child). The requester's next Slack "
              "message is what carries it into the thread, so also state anything still open. Then end.")

NEW_RESULT = ("When the child tree finishes, Paperclip wakes you on the front-door issue (`issue_children_completed`). "
              "Do not reassign anything. Read the finished child, then make **the answer itself your final response**: "
              "plain language, link the child. Give the answer and nothing else — no preamble (\"Answer is in from "
              "ProductGuide…\"), no extra caveats, no \"one thing worth noting\", no offer to scope follow-up work. Do "
              "not create any interaction (no `ask_user_questions`, no `request_confirmation`) on the front-door issue, "
              "do not ask the requester to close anything, and do not set a terminal status. Then end.")

path = f"/api/agents/{CL}/instructions-bundle/file?companyId={C}&path=AGENTS.md"
content = req("GET", path).get("content", "")
if MARK in content:
    print("Clarifier unchanged (already applied)")
else:
    new = content
    if OLD_ROUTE in new:
        new = new.replace(OLD_ROUTE, NEW_ROUTE, 1)
    else:
        print("  no anchor: routing line")
    if OLD_RESULT in new:
        new = new.replace(OLD_RESULT, NEW_RESULT, 1)
    else:
        print("  no anchor: result paragraph")
    if "<!-- frontdoor-mode v1 -->" in new:
        new = new.replace("<!-- frontdoor-mode v1 -->", "<!-- frontdoor-mode v1 -->\n" + MARK, 1)
    else:
        print("  no anchor: frontdoor-mode marker")
    if new != content:
        req("PUT", f"/api/agents/{CL}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new})
        print("Clarifier", "updated" if req("GET", path).get("content") == new else "PUT did not stick")
    else:
        print("Clarifier unchanged")
