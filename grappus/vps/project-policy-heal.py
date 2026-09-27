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
  2. STRIPPED 2026-09-25 (user decision: no project policies, agents self-provision worktrees): the
      auto-apply of the standard policy is disabled. This script never enables a policy anymore; it only
      parks stray enabled policies to `{enabled:false}`. Builders create their own worktrees by hand
      (see Executor/CodeReviewer instructions).
  3. Issues parked `blocked` by a `workspace_validation_failed` run are set back to `todo` once their project is
      runnable again (flag off, or policy just applied), which re-dispatches the assignee.
Run with --dry-run to only print."""
import datetime, json, os, sys, urllib.error, urllib.request

B = "http://127.0.0.1:3100"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
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
        if policy_enabled(pol):
            # Doctrine 2026-09-25: no project policies; agents self-provision. Park any enabled policy.
            log(f"project {p['name']}: policy enabled -> parking to {{enabled:false}} (self-provision doctrine)")
            if not DRY:
                req("PATCH", f"/api/projects/{p['id']}?companyId={C}", {"executionWorkspacePolicy": {"enabled": False}})
            healed.add(p["id"])
        elif with_repo and not policy_enabled(pol):
            # Doctrine 2026-09-25: no project policies; agents self-provision. Never auto-apply. (Silent: steady state.)
            pass
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
