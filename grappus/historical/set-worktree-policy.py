#!/usr/bin/env python3
"""DEPRECATED 2026-09-25 (user decision: no project policies, agents self-provision).
Do not run: it re-applies executionWorkspacePolicy to every project and the
project-policy-heal cron (now parking doctrine) would revert it within a minute.
Kept for history. Replacement: self-provision.py.

Original docstring:
Every task runs in its own git worktree; child issues of one feature/bug share the parent's worktree.
- Projects: executionWorkspacePolicy enabled, isolated_workspace, git_worktree, branch <identifier>-<slug>.
- Executor, QA, CodeReviewer: no agent-level workspaceStrategy (project policy only; see efficiency.py).
- Instructions: Planner creates children with parentId (inherits workspace); Executor/QA/CodeReviewer work only in
  currentExecutionWorkspace from heartbeat-context.
Idempotent. Runs on the VPS as user paperclip."""
import json, os, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
WT_PARENT = "/home/paperclip/worktrees"


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


strategy = {"type": "git_worktree", "baseRef": "origin/main", "branchTemplate": "{{issue.identifier}}-{{slug}}", "worktreeParentDir": WT_PARENT}

for p in req("GET", f"/api/companies/{C}/projects"):
    pol = {"enabled": True, "defaultMode": "isolated_workspace", "sharedWorkspaceConcurrency": "serialize",
           "allowIssueOverride": True, "workspaceStrategy": strategy}
    req("PATCH", f"/api/projects/{p['id']}", {"executionWorkspacePolicy": pol})
    print("project policy set:", p["name"])

agents = {a["name"]: a for a in req("GET", f"/api/companies/{C}/agents")}
# Agent-level workspaceStrategy deliberately NOT set: the project policy is the single source. A second copy
# on the agent made the workspace fingerprint flap every run (see efficiency.py, item 6).

WORKTREE_RULE = """## Worktree rule (mandatory)

Every task runs in its own git worktree. Never work in the project's primary checkout.

1. Start each heartbeat with `GET /api/issues/{id}/heartbeat-context` and read `currentExecutionWorkspace`: `cwd` is the only directory you may read or write, `branchName` is the branch you commit to. If it is `null`, do not create one by hand: mark the issue `blocked` with owner Planner and action "attach a project workspace / realize execution workspace", comment, and end.
2. Child issues of one feature or bug share one worktree. A child created with `parentId` inherits the parent's workspace, so all pieces of the same task land on the same branch. Never create an unrelated worktree for a sibling.
3. Commit on `branchName` only. Push that branch. Never touch `main`/`master` directly, never rebase or force-push another issue's branch.
4. Runtime services (dev server, preview) start through `POST /api/execution-workspaces/{workspaceId}/runtime-services/start`, not ad-hoc background processes. Read the URL from the response.
5. When the task is done and accepted, leave the worktree; Paperclip closes it. Do not delete worktrees yourself.
"""

PLANNER_RULE = """## Worktree rule (mandatory)

Each task is one worktree; all pieces of the same feature or bug share it.

- Create every breakdown item as a child issue with `parentId` = the task issue so they inherit one execution workspace and one branch. Never create breakdown items as top-level issues.
- Independent tasks (different features or bugs) are separate parent issues, so they get separate worktrees and can run in parallel.
- Follow-ups after rejection reuse the same parent (same worktree) unless the scope changed; a scope change means a new parent issue.
- When Executor reports a missing workspace, attach a project workspace (`POST /api/projects/{id}/workspaces` with the repository) and re-wake.
"""

for name, rule in (("Executor", WORKTREE_RULE), ("QA", WORKTREE_RULE), ("CodeReviewer", WORKTREE_RULE), ("Planner", PLANNER_RULE)):
    a = agents[name]
    cur = req("GET", f"/api/agents/{a['id']}/instructions-bundle/file?path=AGENTS.md&companyId={C}")
    body = cur.get("content") or ""
    if "## Worktree rule (mandatory)" in body:
        print(name, "already has worktree rule"); continue
    marker = "## Operating workflow"
    body = body.replace(marker, rule + "\n" + marker, 1) if marker in body else body + "\n" + rule
    req("PUT", f"/api/agents/{a['id']}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": body})
    print(name, "instructions updated")
