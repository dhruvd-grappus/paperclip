#!/usr/bin/env python3
"""Keep every project runnable. Cron every minute as user paperclip (-> /home/paperclip/agents/project-policy-heal.py).

Why (GRA-51, 2026-09-25): with the instance flag `enableIsolatedWorkspacesByDefault` on, Paperclip substitutes
`{enabled:true, defaultMode:"isolated_workspace"}` for any project that has NO executionWorkspacePolicy, and the
adapter config then defaults the strategy to git_worktree. A project created in the UI without a repository has no
project workspace, so its base dir `projects/<company>/<project>/_default` is an empty folder and every run dies
pre-dispatch with
  workspace_validation_failed: ... base workspace ".../_default" is not a git checkout.
Every new project hit this until someone attached a repo AND set a policy by hand.

What this does (idempotent, no per-project config):
  1. Instance flag: force `enableIsolatedWorkspacesByDefault=false`. Projects opt into worktrees through their own
     policy (step 2); a repo-less project runs shared_workspace/project_primary in `_default`, which is fine for
     Clarifier / Planner (they need no code) and lets them ask for a repository instead of crashing.
  2. Any project that has >=1 workspace with a repoUrl but no enabled policy gets the standard one
     (isolated_workspace, git_worktree, branch <identifier>-<slug>, worktreeParentDir, provisionCommand; no baseRef so
     each workspace's repoRef is the worktree base). Same shape as set-worktree-policy.py / add-ateam-project.py.
     The inverse too: an enabled policy on a project with no repo workspace (Onboarding, Nyjii) is set to
     `{enabled:false}` so runs fall back to the shared `_default` dir instead of failing on git_worktree.
  3. Issues parked `blocked` by a `workspace_validation_failed` run are set back to `todo` once their project is
     runnable again (flag off, or policy just applied), which re-dispatches the assignee.
Run with --dry-run to only print."""
import datetime, json, os, sys, urllib.error, urllib.request

B = "http://127.0.0.1:3100"
C = "58cf9282-3a09-4b6d-aaa7-3edf4cde55ad"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"]["https://187.126.114.172.sslip.io"]["token"]
DRY = "--dry-run" in sys.argv
POLICY = {
    "enabled": True,
    "defaultMode": "isolated_workspace",
    "sharedWorkspaceConcurrency": "serialize",
    "allowIssueOverride": True,
    "workspaceStrategy": {
        "type": "git_worktree",
        "branchTemplate": "{{issue.identifier}}-{{slug}}",
        "worktreeParentDir": "/home/paperclip/worktrees",
        "provisionCommand": "/usr/local/bin/provision-worktree",
    },
}


def log(*a):
    print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), *a, flush=True)


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r, timeout=30))
    except urllib.error.HTTPError as e:
        log("ERR", m, p, e.code, e.read().decode()[:300])
        raise


def policy_enabled(p):
    return isinstance(p, dict) and p.get("enabled") is True


def heal_flag():
    s = req("GET", "/api/instance/settings/experimental")
    if s.get("enableIsolatedWorkspacesByDefault"):
        log("instance: enableIsolatedWorkspacesByDefault is on -> turning off (breaks repo-less projects)")
        if not DRY:
            req("PATCH", "/api/instance/settings/experimental", {"enableIsolatedWorkspacesByDefault": False})
        return True
    return False


def heal_projects():
    healed = set()
    for p in req("GET", f"/api/companies/{C}/projects"):
        if p.get("archivedAt"):
            continue
        ws = req("GET", f"/api/projects/{p['id']}/workspaces?companyId={C}")
        with_repo = [w for w in ws if (w.get("repoUrl") or "").strip()]
        pol = p.get("executionWorkspacePolicy")
        if with_repo and not policy_enabled(pol):
            log(f"project {p['name']}: {len(with_repo)} repo workspace(s), no enabled policy -> applying standard policy")
            if not DRY:
                req("PATCH", f"/api/projects/{p['id']}?companyId={C}", {"executionWorkspacePolicy": POLICY})
            healed.add(p["id"])
        elif not with_repo and policy_enabled(pol):
            # git_worktree with nothing to cut from == the GRA-51 crash. Park the policy; step 2 re-applies it the
            # minute a repo workspace appears.
            log(f"project {p['name']}: policy enabled but no repo workspace -> disabling policy (shared workspace until a repo is attached)")
            if not DRY:
                req("PATCH", f"/api/projects/{p['id']}?companyId={C}", {"executionWorkspacePolicy": {"enabled": False}})
            healed.add(p["id"])
    return healed


def wake_blocked(project_ids, all_projects):
    issues = req("GET", f"/api/companies/{C}/issues?status=blocked")
    issues = issues if isinstance(issues, list) else issues.get("items", [])
    for i in issues:
        if i.get("status") != "blocked" or not i.get("assigneeAgentId"):
            continue
        pid = i.get("projectId")
        if not (all_projects or (pid and pid in project_ids)):
            continue
        runs = req("GET", f"/api/issues/{i['id']}/runs?companyId={C}")
        last = runs[0] if runs else None
        if not last or last.get("errorCode") != "workspace_validation_failed":
            continue
        log(f"issue {i['identifier']}: blocked by workspace_validation_failed, project runnable again -> todo")
        if not DRY:
            req("PATCH", f"/api/issues/{i['id']}?companyId={C}", {"status": "todo"})


if __name__ == "__main__":
    flag_fixed = heal_flag()
    healed = heal_projects()
    if flag_fixed or healed:
        wake_blocked(healed, all_projects=flag_fixed)
