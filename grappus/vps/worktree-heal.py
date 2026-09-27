#!/usr/bin/env python3
"""Self-heal stale execution workspaces. Cron every minute as user paperclip (→ /home/paperclip/agents/worktree-heal.py).

Paperclip binds an issue to an execution workspace (a git worktree) on its first run. If the issue later moves to
another repo (projectWorkspaceId changes, e.g. Clarifier re-routes inside a multi-repo project) or another project,
the bound worktree belongs to the wrong repo and every run fails with
  Persisted git worktree "..." is not reusable (path is not registered in `git worktree list`).
Same failure when the worktree directory vanished. Paperclip does not recover by itself.

For each open issue whose bound workspace no longer matches (repo, project, or missing dir):
  1. archive the execution workspace and clear the issue's executionWorkspaceId (next run provisions a fresh one
     from the right repo),
  2. free the worktree path: clean worktree -> `git worktree remove` + delete branch; uncommitted changes or
     local-only commits -> `git worktree move` to <path>.stale-<ts> so nothing is lost,
  3. wake the assignee (blocked with no blockers -> todo; else a comment mentioning the agent by id).
Generic: works for every project and repo, no per-project config. Idempotent."""
import datetime, json, os, subprocess, sys, time, urllib.request

B = "http://127.0.0.1:3100"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"]["https://187.126.114.172.sslip.io"]["token"]
TERMINAL = {"done", "cancelled"}
IGNORE_DIRTY = (".claude/", ".paperclip-runtime/")
MIN_AGE_S = 180  # never touch a workspace younger than this (worktree may still be provisioning)
DRY = "--dry-run" in sys.argv


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))


def git(*args):
    p = subprocess.run(["git", *args], capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout.strip()


def primary_of(wt):
    rc, common = git("-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return os.path.dirname(common) if rc == 0 and common.endswith("/.git") else None


def registered(primary, wt):
    rc, out = git("-C", primary, "worktree", "list", "--porcelain")
    return rc == 0 and f"worktree {wt}" in out.splitlines()


def free_path(wt, branch):
    """Returns a short note for the issue comment."""
    if not os.path.isdir(wt):
        return "worktree directory was already gone"
    primary = primary_of(wt)
    if not primary or not registered(primary, wt):
        dest = f"{wt}.stale-{int(time.time())}"
        os.rename(wt, dest)
        return f"orphan directory moved to `{dest}`"
    _, status = git("-C", wt, "status", "--porcelain")
    dirty = [l for l in status.splitlines() if not l[3:].startswith(IGNORE_DIRTY)]
    _, local_only = git("-C", wt, "log", "--oneline", "HEAD", "--not", "--remotes")
    if dirty or local_only:
        dest = f"{wt}.stale-{int(time.time())}"
        git("-C", primary, "worktree", "move", wt, dest)
        return f"old worktree had unsaved work ({len(dirty)} changed files, {len(local_only.splitlines())} unpushed commits); kept at `{dest}`"
    git("-C", primary, "worktree", "remove", "--force", wt)
    if branch:
        git("-C", primary, "branch", "-D", branch)
    return f"clean old worktree removed from `{os.path.basename(primary)}`"


agents = {a["id"]: a["name"] for a in req("GET", f"/api/companies/{C}/agents")}
workspaces = {w["id"]: w for w in req("GET", f"/api/companies/{C}/execution-workspaces")}
issues = [i for i in req("GET", f"/api/companies/{C}/issues") if i.get("executionWorkspaceId") and i["status"] not in TERMINAL]
users = {}  # workspace id -> open issues bound to it
for i in issues:
    users.setdefault(i["executionWorkspaceId"], []).append(i)

for i in issues:
    ws = workspaces.get(i["executionWorkspaceId"])
    if not ws:
        continue
    created = datetime.datetime.fromisoformat(ws["createdAt"].replace("Z", "+00:00"))
    if (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds() < MIN_AGE_S:
        continue
    reason = None
    if ws.get("status") != "active":
        reason = f"bound workspace is `{ws.get('status')}`"
    elif i.get("projectId") and ws.get("projectId") and ws["projectId"] != i["projectId"]:
        reason = "issue moved to another project"
    elif i.get("projectWorkspaceId") and ws.get("projectWorkspaceId") and ws["projectWorkspaceId"] != i["projectWorkspaceId"]:
        reason = "issue moved to another repo in the project"
    elif ws.get("strategyType", "git_worktree") == "git_worktree" and ws.get("cwd"):
        if not os.path.isdir(ws["cwd"]):
            reason = "worktree directory is missing"
        else:
            p = primary_of(ws["cwd"])
            if not p or not registered(p, ws["cwd"]):
                reason = "worktree is not registered in its repo"
    if not reason:
        continue

    if DRY:
        print("DRY", i["identifier"], reason); continue
    note = "workspace files left in place (already inactive or still used by another open issue)"
    others = [o for o in users.get(ws["id"], []) if o["id"] != i["id"]]
    if ws.get("status") == "active" and not others:
        req("PATCH", f"/api/execution-workspaces/{ws['id']}", {"status": "archived"})
        if ws.get("cwd"):
            note = free_path(ws["cwd"], ws.get("branchName"))
    patch = {"executionWorkspaceId": None}
    aid = i.get("assigneeAgentId")
    msg = f"Worktree self-heal: {reason}. Unbound the stale workspace; {note}. The next run provisions a fresh worktree from the issue's current repo."
    if i["status"] == "blocked" and not i.get("blockedByIssueIds") and aid:
        patch.update({"status": "todo", "comment": msg})  # status change wakes the assignee
    elif aid:
        patch["comment"] = msg + f" [@{agents.get(aid, 'agent')}](agent://{aid}) continue."
    else:
        patch["comment"] = msg
    req("PATCH", f"/api/issues/{i['id']}", patch)
    print(time.strftime("%F %T"), i["identifier"], reason, "|", note)
