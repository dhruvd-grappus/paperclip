#!/usr/bin/env python3
"""Give Clarifier responsibility for provisioning missing project clones.

Run on the VPS as paperclip. The live AGENTS.md bundle is canonical. This
patch is idempotent and leaves existing repositories untouched.
"""

import json
import os
import urllib.request

BASE = "https://187.126.114.172.sslip.io"
COMPANY = "d255c3a4-2066-4d81-8c40-862ad8208963"
CLARIFIER = "221ca6db-6cf1-49ff-bdf1-270a53c201f9"
MARKER = "<!-- clarifier-clone-repos v1 -->"
TOKEN = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][BASE]["token"]


def request(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as response:
        return json.load(response)


path = f"/api/agents/{CLARIFIER}/instructions-bundle/file?companyId={COMPANY}&path=AGENTS.md"
content = request("GET", path)["content"]
if MARKER in content:
    print("Clarifier unchanged (already applied)")
    raise SystemExit

old_boundary = "- Never open, read, or modify the code repository or the workspace. Your inputs are: the request, the conversation, the vault documents, related issues, and the project description."
new_boundary = "- Do not inspect source code or change files in a repository. The only repository operation you own is cloning a configured project workspace when its primary clone is missing, as described below. Your scoping inputs remain the request, conversation, vault documents, related issues, and project description."
anchor = "## Vault = PARA memory (mandatory)"
frontdoor_anchor = "2. `POST /api/companies/d255c3a4-2066-4d81-8c40-862ad8208963/issues` with:"
section = f"""{MARKER}
## Provision missing project repositories (after project routing)

Once the project is known, before handing a child to ProductGuide or Clarifier and before handing scoped work to Planner, ensure every configured `sourceType: git_repo` workspace has a local primary clone. Read `GET /api/projects/{{projectId}}`. The clone root is the parent directory of `codebase.managedFolder` for the primary workspace; each configured workspace's destination is that root plus its `name`. Use only the configured `repoUrl` and `repoRef` (or `defaultRef`) from the workspace. Reject names containing `/`, `..`, or path separators. Never invent a repository URL or destination.

For each configured workspace, check `git -C <destination> rev-parse --is-inside-work-tree`. If it succeeds, leave that repository alone: no fetch, pull, checkout, reset, or worktree. If the destination does not exist, run `git clone --branch <repoRef> --single-branch <repoUrl> <destination>` as the `paperclip` user, using the host's existing Git credential helper. Do not put tokens in URLs, output, comments, or documents. This clone is the sole exception to your no-repository-write boundary; do not read source files or run builds.

If a destination exists but is not a Git checkout, or a clone fails, do not overwrite or retry blindly. Record the workspace name and the safe error summary on the child issue (or in the Scope for a normal issue), and hand off with that limitation visible. If no `repoUrl` is configured, say which repository is needed; do not guess it. A pure product question may need several workspaces, so check all configured workspaces before routing it.

"""

if old_boundary not in content or anchor not in content or frontdoor_anchor not in content:
    raise RuntimeError("Clarifier instructions changed; update patch anchors before writing")
updated = content.replace(old_boundary, new_boundary, 1).replace(anchor, section + anchor, 1)
updated = updated.replace(
    frontdoor_anchor,
    "1c. Ensure the project's configured Git workspaces are cloned as described in 'Provision missing project repositories' below. Include any clone limitation in the child's description.\n"
    + frontdoor_anchor,
    1,
)
request("PUT", f"/api/agents/{CLARIFIER}/instructions-bundle/file?companyId={COMPANY}", {"path": "AGENTS.md", "content": updated})
if request("GET", path)["content"] != updated:
    raise RuntimeError("Clarifier instruction readback differs from update")
print("Clarifier repository clone rule updated and verified")
