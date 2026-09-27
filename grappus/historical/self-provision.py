#!/usr/bin/env python3
"""Self-provision doctrine: no project executionWorkspacePolicy anywhere.

Why (user decision 2026-09-25): managed worktrees slowed non-coding agents and
central policy caused flap. Builders create their own git worktrees by hand.
Replaces the "## Worktree rule (mandatory)" section on Executor, QA,
CodeReviewer, Planner. Idempotent (marker self-provision v1). Run on VPS as
paperclip."""
import json, re, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
MARK = "<!-- self-provision v1 -->"


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


K = json.load(open(__import__("os").path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]

EXECUTOR_RULE = """## Worktree rule (self-provision, mandatory)

There is no managed execution workspace. You create your own git worktree per task.

1. Find the repo: `GET /api/projects/{projectId}` → `codebase.effectiveLocalFolder` is the primary clone (fallback: match `workspaces[].repoUrl` under `~/.paperclip/instances/default/projects/<companyId>/<projectId>/`). If the project has no repo workspace, mark the issue `blocked` (owner Planner, action "attach a repository workspace") and end.
2. Worktree dir: `/home/paperclip/worktrees/<ISSUE-IDENTIFIER>-<short-slug>` (e.g. `GRA-71-excel-sheet-of-all-post-onboarding-pushes`). If that dir already exists with your branch checked out, reuse it. Else: `git -C <primary> fetch origin && git -C <primary> worktree add <dir> -b <IDENTIFIER>-<short-slug> origin/<repoRef>` where `repoRef` is the workspace `repoRef` from step 1. Then warm it: run `/usr/local/bin/provision-worktree` inside the new dir (hard-links `node_modules` from the primary when the lockfile matches), else `npm ci`/`pnpm install` per lockfile.
3. Work only in that dir, commit and push only your branch. Never commit in the primary clone, never touch `main`/`master` directly, never rebase or force-push another issue's branch.
4. Preview and handoffs are unchanged: `preview-url start` from the worktree dir is the only way to start dev servers; review sub-issues to QA/CodeReviewer as before.
5. Leave the worktree when done (the preview serves from it; Planner's link gate needs it). Do not delete worktrees yourself.
"""

QA_RULE = """## Worktree rule (self-provision, mandatory)

There is no managed execution workspace, and you need none. You never touch code.

1. Verify at the preview URL Executor hands you, from your sandbox, Playwright only.
2. If you must inspect code, read-only: `git -C <primary> fetch origin <branch> && git show origin/<branch>:<path>` or `git diff`. Never create a worktree, never check out code, never commit.
"""

REVIEWER_RULE = """## Worktree rule (self-provision, mandatory)

There is no managed execution workspace, and you need none. You review, you never change code.

1. Read the diff read-only in the primary clone (`GET /api/projects/{projectId}` → `codebase.effectiveLocalFolder`): `git fetch origin <branch> && git diff origin/<base>...origin/<branch>`. Never create a worktree, never check out the branch, never commit or push.
"""

PLANNER_RULE = """## Worktree rule (self-provision, mandatory)

There is no managed execution workspace. Builders create their own git worktrees by hand per issue.

- Create every breakdown item as a child issue with `parentId` = the task issue and the parent's `projectId` passed explicitly. Independent tasks (different features or bugs) are separate parent issues so they can run in parallel.
- Follow-ups after rejection reuse the same parent (same branch) unless the scope changed; a scope change means a new parent issue.
- When Executor reports a missing repo, attach a project workspace (`POST /api/projects/{id}/workspaces` with the repository) and re-wake.
"""

RULES = {"Executor": EXECUTOR_RULE, "QA": QA_RULE, "CodeReviewer": REVIEWER_RULE, "Planner": PLANNER_RULE}

agents = {a["name"]: a for a in req("GET", f"/api/companies/{C}/agents")}
for name, rule in RULES.items():
    a = agents[name]
    path = f"/api/agents/{a['id']}/instructions-bundle/file?companyId={C}&path=AGENTS.md"
    cur = req("GET", path).get("content", "")
    if MARK in cur:
        print(name, "already applied"); continue
    new, n = re.subn(r"## Worktree rule \(mandatory\).*?(?=\n## )", MARK + "\n" + rule.rstrip("\n"), cur, count=1, flags=re.S)
    if n == 0:
        # QA variant: bare "## Worktree rule" already sandbox-only (no worktree). Just tag the marker.
        if name == "QA" and "## Worktree rule\n" in cur and MARK not in cur:
            new = cur.replace("## Worktree rule\n", MARK + "\n## Worktree rule\n", 1)
            req("PUT", path, {"path": "AGENTS.md", "content": new})
            print(name, "marked (already sandbox-only)")
        else:
            print(name, "no anchor: worktree section missing")
        continue
    req("PUT", path, {"path": "AGENTS.md", "content": new})
    print(name, "updated" if req("GET", path).get("content") == new else "PUT did not stick")
