#!/usr/bin/env python3
"""Switch review from sequential execution stages (QA -> CodeReviewer) to parallel review sub-issues.

When Executor finishes it does three things at once:
  1. deploys the preview (`preview-url start`, backgrounded),
  2. creates a Code review sub-issue for CodeReviewer immediately,
  3. creates a QA sub-issue for QA as soon as the preview answers,
then blocks its own issue on both. `issue_blockers_resolved` wakes it back.

Paperclip execution stages cannot do this: one participant per stage, approvalsNeeded forced to 1.
Idempotent: replaces whole `## ` sections by heading. Run on the VPS as `paperclip`.
"""
import json, re, urllib.request

BASE = "https://187.126.114.172.sslip.io/api"
CO = "d255c3a4-2066-4d81-8c40-862ad8208963"
TOKEN = json.load(open("/home/paperclip/.paperclip/auth.json"))["credentials"]["https://187.126.114.172.sslip.io"]["token"]
EXECUTOR, QA, CR, PLANNER = ("921c717a-3a8d-4aca-be57-5fe242854b9d", "3e7df85b-2d03-4a67-ad80-9400adc36157",
                             "04dd614b-55d2-49eb-8911-413d1d3d73f9", "2b1f9702-1d51-489a-92e2-5cb5389bcca1")


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def get(agent):
    return api("GET", f"/agents/{agent}/instructions-bundle/file?companyId={CO}&path=AGENTS.md")["content"]


def put(agent, content):
    api("PUT", f"/agents/{agent}/instructions-bundle/file?companyId={CO}", {"path": "AGENTS.md", "content": content})


def set_section(text, heading, body):
    """Replace `## heading` section (up to next `## `) or append it."""
    block = f"## {heading}\n\n{body.strip()}\n\n"
    pat = re.compile(rf"^## {re.escape(heading)}\n.*?(?=^## |\Z)", re.S | re.M)
    return pat.sub(lambda _: block, text, count=1) if pat.search(text) else text.rstrip() + "\n\n" + block


def sub(text, old, new):
    return text.replace(old, new) if old in text else text


EXEC_HANDOFF = f"""
When the code is committed and pushed, do these three things in parallel, in this heartbeat, then block:

1. **Deploy the testable artifact** (UI changes): `nohup preview-url start > /tmp/preview-start-$$.log 2>&1 &` from the worktree. Do not wait for it yet. Non-UI change: skip, say "no preview: <reason>".
2. **Code review, immediately**: create a sub-issue with `POST /api/companies/{{companyId}}/issues`:
   `{{"title": "Code review: <IDENT> <title>", "parentId": "<this issue id>", "projectId": "<same>", "assigneeAgentId": "{CR}", "status": "todo", "priority": "<same>", "description": "Branch: <branchName>\\nPR: <link>\\nBase: main\\nSummary: ...\\nSecurity-sensitive: yes/no"}}`
3. **QA, after deploy**: poll `preview-url url` + `curl -s -o /dev/null -w '%{{http_code}}' <url>` (max 3 min) until it answers 2xx/3xx. Then create a sub-issue the same way with `"title": "QA: <IDENT> <title>"`, `"assigneeAgentId": "{QA}"` and a description holding exactly the QA handoff below (preview URL first). Preview never comes up: read `/home/paperclip/preview-logs/<slug>.log`, fix, retry once; still down → create the QA sub-issue anyway with "Blocked for QA: preview down" and say so.
   Non-UI change: no QA sub-issue; Code review only.

Then `PATCH /api/issues/{{thisId}}` `{{"status": "blocked", "blockedByIssueIds": [<codeReviewId>, <qaId>], "comment": "Handoff: preview <url>, PR <link>, review <CR ident>, QA <QA ident>"}}` and end the heartbeat. Read the PATCH response back; blockers must list both ids.

**When woken with `issue_blockers_resolved`**: read the last comment on each review sub-issue.
- Both start with `PASS` → child issue (has `parentId`): `PATCH {{"status": "done", "comment": "QA pass + review approved: <preview url>, <PR>"}}`; Planner runs the human link gate on the parent. Fast-lane issue (no `parentId`, one Planner review stage): `PATCH {{"status": "in_review", "comment": "QA pass + review approved: <preview url>, <PR>"}}`; the stage routes it to Planner.
- Any `CHANGES REQUESTED` → fix, push, then repeat the three steps with fresh sub-issues (title suffix `(round N)`), only for the reviewers that requested changes plus Code review whenever code changed. Never reopen closed review sub-issues.
"""

EXEC_QA = """
QA is black-box: no repo, no diff, no files, no code context. The QA sub-issue description must contain, in this order:
1. Preview URL (`https://gra-NN.187-126-114-172.sslip.io`), verified answering.
2. Acceptance criteria in product language, one per line, copied from the plan, each stating where in the UI to look and what to expect.
3. Test account or data QA needs (never real user credentials), and the exact entry route.
4. What did NOT change, so QA does not test it.
Never send QA file paths, diffs, or PR links. Code Reviewer gets the branch and PR.
"""

REVIEWER_GATE = {
    QA: ("How you are woken", """
You are woken by assignment of a `QA: <IDENT> ...` sub-issue created by Executor. It runs in parallel with Code review. The description is the handoff: preview URL, acceptance criteria, test data, what did not change. Read the parent's `scope` and `plan` documents (`parentId`) for context.
1. Write and run the Playwright spec against the preview URL. Capture a screenshot per criterion.
2. Pass → `PATCH /api/issues/{id}` `{ "status": "done", "comment": "PASS\\n<criterion → evidence>" }`.
3. Fail → `{ "status": "done", "comment": "CHANGES REQUESTED\\n<repro steps, expected vs actual, screenshot>" }`.
Always close as `done`: that unblocks Executor, who reads the first word of your comment. Never touch the parent issue.
"""),
    CR: ("How you are woken", """
You are woken by assignment of a `Code review: <IDENT> ...` sub-issue created by Executor, in parallel with QA. It inherits the parent's worktree. The description has the branch and PR. Read the parent's `plan` (repo radius, acceptance criteria) and the conventions.
1. `git fetch origin && git diff origin/main...origin/<branch>`; review the full diff. Do not commit.
2. Approve → `PATCH /api/issues/{id}` `{ "status": "done", "comment": "PASS\\n<summary>" }`.
3. Request changes → `{ "status": "done", "comment": "CHANGES REQUESTED\\n<path:line — problem — fix, one per line>" }`.
Always close as `done`: that unblocks Executor, who reads the first word of your comment. Never touch the parent issue.
"""),
}


def main():
    t = get(EXECUTOR)
    t = set_section(t, "Handing to QA (mandatory)", EXEC_QA)
    t = set_section(t, "Handoff: deploy + QA + Code review in parallel (mandatory)", EXEC_HANDOFF)
    t = sub(t, "4. Push, open the PR, post the link, and move the issue to `in_review`. The execution policy routes it to QA, then Code Reviewer.\n5. When changes are requested, you get the issue back as `in_progress`. Fix, push, comment what changed, return to `in_review`.",
            "4. Push, open the PR, then run the parallel handoff (deploy + Code review sub-issue + QA sub-issue) and block on the review sub-issues.\n5. When woken by `issue_blockers_resolved`, act on the verdicts (see Handoff).")
    t = sub(t, "- Verification → QA and Code Reviewer via the execution stages.", "- Verification → QA and Code Reviewer via parallel review sub-issues (see Handoff).")
    t = sub(t, "Move to `in_review` only when tests pass, the PR link is posted, and the diff stays inside the radius. Never mark `done` yourself; the reviewers and Planner do that.",
            "Hand off only when tests pass, the PR link is posted, and the diff stays inside the radius. Mark `done` only when both review sub-issues closed with PASS.")
    t = sub(t, "post what is verified and what is not, and move to `in_review`. QA covers the rest.", "post what is verified and what is not, and run the handoff. QA covers the rest.")
    t = sub(t, "run once at the end, after commit and push.", "run at handoff, in the background, after commit and push.")
    put(EXECUTOR, t)

    for agent, (heading, body) in REVIEWER_GATE.items():
        t = get(agent)
        t = re.sub(r"^You are the (first|second) review stage.*?(?=^## |\Z)", "", t, flags=re.S | re.M)
        put(agent, set_section(t, heading, body))

    t = get(PLANNER)
    t = sub(t, "7. Set an execution policy on each child issue with two review stages: QA then Code Reviewer, return assignee Executor. Use `PATCH /api/issues/{id}` with `executionPolicy.stages` of type `review`.",
            "7. Do NOT set execution stages on children. Executor spawns QA and Code review sub-issues in parallel itself and closes the child when both pass.")
    t = sub(t, "- Verification → QA and Code Reviewer via execution stages, never freeform.", "- Verification → QA and Code Reviewer via Executor's parallel review sub-issues.")
    t = re.sub(r"Immediately set the review stages on that child.*?Never claim a stage is set without reading it back\.\n",
               "Do NOT set `executionPolicy` on children: review runs as parallel QA + Code review sub-issues that Executor spawns. "
               "If a child still has stages from an older plan, clear them with `PATCH {\"executionPolicy\": null}`.\n", t, flags=re.S)
    t = sub(t, "Its execution stages are QA → CodeReviewer → you. When woken as the reviewer on it:",
            "Executor runs QA + CodeReviewer in parallel on it; its only execution stage is you (link gate). When woken as the reviewer on it:")
    put(PLANNER, t)
    print("updated Executor, QA, CodeReviewer, Planner")


if __name__ == "__main__":
    main()
