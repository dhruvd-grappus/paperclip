#!/usr/bin/env python3
"""Create the Ateam project (two GitLab repos: iOS app + React admin), its PARA vault issue, and a registry row.
Repo access: GitLab PAT via git credential helper (~paperclip/.local/bin/git-credential-gitlab-pat, reads $GITLAB_PAT or ~/.gitlab_pat).
Idempotent. Runs on the VPS as user paperclip. Does not touch agent instructions."""
import json, os, urllib.request, datetime

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
TODAY = datetime.date.today().isoformat()
NAME = "Ateam"


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


def get_doc(issue_id, key):
    try:
        return req("GET", f"/api/issues/{issue_id}/documents/{key}")
    except Exception:
        return None


def put_doc(issue_id, key, title, body, overwrite=False):
    cur = get_doc(issue_id, key)
    if cur and not overwrite:
        return "kept"
    payload = {"title": title, "format": "markdown", "body": body}
    if cur:
        payload["baseRevisionId"] = cur.get("latestRevisionId") or cur.get("revisionId")
    req("PUT", f"/api/issues/{issue_id}/documents/{key}", payload)
    return "written"


DESCRIPTION = """Ateam: dating + friendship app (ateaminc). Two repos, pick the workspace by what the task touches:

- **ateam-ios** (primary): native iOS app, Swift/SwiftUI, Xcode + CocoaPods + fastlane. GitLab `dhruv-grappus/ateam/ateam`, base branch `dev`. App code under `ATeam/`. Cannot be built, run or previewed on the Linux host: no xcodebuild, no simulator, no preview URL. Executor edits and self-reviews only; QA is skipped; a human verifies on a Mac.
- **ateam-admin**: internal admin console (profile moderation, growth attribution, subscriptions, fast-passes, nominations, referral codes). React 18 CRA (`react-scripts`), antd, redux + react-query, npm. GitLab `dhruv-grappus/ateam/ateam-admin`, base branch `dev-vinay`. Previewable via `preview-url start` (`npm start`).

Routing: admin console / moderation / ops tooling → set the issue's `projectWorkspaceId` to ateam-admin. Anything in the mobile app → ateam-ios. A task spanning both = two child issues, one per workspace."""

WORKSPACES = [
    {"name": "ateam-ios", "sourceType": "git_repo", "repoUrl": "https://gitlab.com/dhruv-grappus/ateam/ateam.git",
     "repoRef": "dev", "defaultRef": "dev", "isPrimary": True},
    {"name": "ateam-admin", "sourceType": "git_repo", "repoUrl": "https://gitlab.com/dhruv-grappus/ateam/ateam-admin.git",
     "repoRef": "dev-vinay", "defaultRef": "dev-vinay", "isPrimary": False},
    {"name": "with-notification-service", "sourceType": "git_repo",
     "repoUrl": "https://gitlab.com/dhruv-grappus/ateam/with-notification-service.git",
     "repoRef": "develop", "defaultRef": "develop", "isPrimary": False},
    {"name": "with-utilities", "sourceType": "git_repo",
     "repoUrl": "https://gitlab.com/dhruv-grappus/ateam/with-utilities.git",
     "repoRef": "master", "defaultRef": "master", "isPrimary": False},
]

# Same as the other projects, minus baseRef: the two repos have different base branches,
# so the worktree base falls back to each workspace's repoRef.
POLICY = {
    "enabled": True, "sharedWorkspaceConcurrency": "serialize", "defaultMode": "isolated_workspace", "allowIssueOverride": True,
    "workspaceStrategy": {"type": "git_worktree", "branchTemplate": "{{issue.identifier}}-{{slug}}",
                          "worktreeParentDir": "/home/paperclip/worktrees", "provisionCommand": "/usr/local/bin/provision-worktree"},
}

# ---- project ----
proj = next((p for p in req("GET", f"/api/companies/{C}/projects") if p["name"] == NAME), None)
if not proj:
    proj = req("POST", f"/api/companies/{C}/projects", {"name": NAME, "description": DESCRIPTION, "status": "in_progress",
                                                        "executionWorkspacePolicy": POLICY})
    print("project created", proj["id"])
else:
    req("PATCH", f"/api/projects/{proj['id']}", {"description": DESCRIPTION, "executionWorkspacePolicy": POLICY})
    print("project exists, description + policy synced", proj["id"])
pid = proj["id"]

have = {w["name"]: w for w in req("GET", f"/api/projects/{pid}/workspaces")}
for w in WORKSPACES:
    if w["name"] in have:
        req("PATCH", f"/api/projects/{pid}/workspaces/{have[w['name']]['id']}", w); print("workspace synced", w["name"])
    else:
        print("workspace created", w["name"], req("POST", f"/api/projects/{pid}/workspaces", w)["id"])

# ---- vault issue (projects/<urlKey>) ----
proj = req("GET", f"/api/projects/{pid}")
key = proj.get("urlKey") or "ateam"
title = f"Vault: {NAME}"
vault = next((i for i in req("GET", f"/api/companies/{C}/issues?projectId={pid}") if i["title"] == title), None)
if not vault:
    vault = req("POST", f"/api/companies/{C}/issues", {
        "title": title, "status": "todo", "priority": "low", "projectId": pid,
        "description": "Standing vault issue. Documents on this issue are the project's long-term memory (PARA `projects/" + key + "`). Read `summary` first, `items` on demand. Never mark done."})
    print("vault issue created", vault["identifier"])
vid = vault["id"]

SUMMARY = f"""# {NAME} — summary

_PARA project (projects/{key}). Quick context for agents: load this first, `items` on demand. Rewritten by Planner when 10+ new facts accumulate or weekly._

## What this is
- Ateam: dating + friendship app. Two repos: `ateam-ios` (native iOS app) and `ateam-admin` (internal React admin console for ops/growth).

## Current state
- Project added {TODAY}. No pipeline tasks run yet.

## Hard constraints agents must respect
- `ateam-ios` cannot be built or run on the host (Linux, no Xcode). No build, no tests, no preview, no QA stage. Say so in the issue; a human verifies on a Mac.
- `ateam-admin` base branch is `dev-vinay`, `ateam-ios` base branch is `dev`. Never push to `production`, `master` or `main`.
- see `repo-radius` and `conventions`

## Recent decisions
- (none yet)
"""

ITEMS = f"""```yaml
# items.yaml — atomic facts for {NAME} (PARA {key})
# Schema per fact: id, fact, category (decision|constraint|architecture|convention|gotcha|milestone|status),
#   timestamp, source, status (active|superseded), superseded_by, related_entities, last_accessed, access_count
# Rules: never delete; supersede. Only critical facts (see AGENTS.md "Vault write rule").
- id: {key}-001
  fact: "ateam-ios is native Swift/SwiftUI (Xcode, CocoaPods, fastlane); it cannot be built, tested or previewed on the Linux host."
  category: constraint
  timestamp: "{TODAY}"
  source: "setup"
  status: active
  superseded_by: null
  related_entities: [projects/{key}]
  last_accessed: "{TODAY}"
  access_count: 0
- id: {key}-002
  fact: "Base branches: ateam-ios = dev, ateam-admin = dev-vinay (GitLab default branches)."
  category: convention
  timestamp: "{TODAY}"
  source: "setup"
  status: active
  superseded_by: null
  related_entities: [projects/{key}]
  last_accessed: "{TODAY}"
  access_count: 0
```
"""

GOALS = f"""# Goals: {NAME}

## Current goals
- (fill in)
"""

CONVENTIONS = f"""# Conventions: {NAME}

## ateam-ios
- Swift / SwiftUI, Xcode workspace `ATeam/ATeam.xcworkspace`, CocoaPods (`Podfile`), fastlane, Firebase, Klaviyo, Customer.io, Maestro UI flows.
- Repo guide: `ATeam/CLAUDE.md` (graphify for code lookup, surgical changes). Read it before editing.
- No build or test possible on the host: keep changes small, match surrounding code, list what a human must verify on device.

## ateam-admin
- React 18, Create React App (`react-scripts`), antd, redux + redux-thunk, @tanstack/react-query, axios, react-final-form. npm (`package-lock.json`).
- Scripts: `npm start` (dev server), `npm run build`, `npm test` (Jest via react-scripts).
- Product/design rules: `PRODUCT.md`, `DESIGN.md` in the repo. Internal work tool: product terms for statuses, no marketing copy.
"""

RADIUS = f"""# Repo radius: {NAME}

## ateam-ios — allowed by default
- `ATeam/ATeam/**` (app source), `ATeam/ATeamTests/**`
## ateam-ios — ask first
- `Podfile`, `Podfile.lock`, `Pods/**`, `*.xcodeproj/**` (project file), `fastlane/**`, `firebase.json`, `remoteconfig.template.json`, `*.xcconfig`, entitlements, Info.plist

## ateam-admin — allowed by default
- `src/**`, `public/**` (non-config assets)
## ateam-admin — ask first
- `package.json`, `package-lock.json`, `.env*`, `build/**`

## Never
- Secrets, signing certs/profiles, `mongo-backups/**`, force-push, pushes to `production` / `master` / `main`
"""

for dk, dt, body in (("summary", f"Summary: {NAME}", SUMMARY), ("items", f"Items (atomic facts): {NAME}", ITEMS),
                     ("goals", f"Goals: {NAME}", GOALS), ("conventions", f"Conventions: {NAME}", CONVENTIONS),
                     ("repo-radius", f"Repo radius: {NAME}", RADIUS)):
    print(vault["identifier"], dk, put_doc(vid, dk, dt, body))

# ---- registry row on the company vault (areas/company) ----
company = next((i for i in req("GET", f"/api/companies/{C}/issues") if i["title"] == "Vault: company" and not i.get("projectId")), None)
reg = get_doc(company["id"], "registry") if company else None
if not reg:
    print("WARN no company registry doc; add the row by hand")
elif vid in (reg.get("body") or ""):
    print("registry row present")
else:
    row = f"| projects/{key} ({NAME}) | {vault['identifier']} | {vid} | summary, items, goals, conventions, repo-radius |"
    lines = reg["body"].split("\n")
    last = max(i for i, l in enumerate(lines) if l.startswith("|"))  # insert after the last table row
    body = "\n".join(lines[:last + 1] + [row] + lines[last + 1:])
    req("PUT", f"/api/issues/{company['id']}/documents/registry",
        {"title": reg.get("title") or "Vault registry", "format": "markdown", "body": body,
         "baseRevisionId": reg.get("latestRevisionId") or reg.get("revisionId")})
    print("registry row added")
