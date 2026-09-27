#!/usr/bin/env python3
"""Move the vault into Paperclip so it is viewable in the UI.

Per project: a standing issue "Vault: <project>" (status todo, label-free) inside that project, holding documents
  goals, conventions, repo-radius, history, decisions
Company-wide: a standing issue "Vault: company" (no project) with conventions, repo-radius, decisions.
Seeds each document from the on-disk vault, then rewrites agent instructions so the API documents are canonical.
Idempotent. Runs on the VPS as user paperclip."""
import json, os, pathlib, re, urllib.request, urllib.parse

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
VAULT = pathlib.Path(f"/home/paperclip/.paperclip/instances/default/companies/{C}/vault")


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:300]); raise


def find_or_create_vault_issue(title, project_id):
    q = urllib.parse.quote(title)
    found = [i for i in req("GET", f"/api/companies/{C}/issues?q={q}") if i["title"] == title and (i.get("projectId") == project_id)]
    if found:
        return found[0]
    body = {"title": title, "status": "todo", "priority": "low",
            "description": "Standing vault issue. Documents on this issue are the project's long-term memory: goals, conventions, repo radius, history, decisions. Agents read them before every task and append to history on close. Never mark done."}
    if project_id:
        body["projectId"] = project_id
    return req("POST", f"/api/companies/{C}/issues", body)


def put_doc(issue_id, key, title, body_md):
    existing = {d["key"] for d in req("GET", f"/api/issues/{issue_id}/documents")} if True else set()
    if key in existing:
        return "kept"
    req("PUT", f"/api/issues/{issue_id}/documents/{key}", {"title": title, "format": "markdown", "body": body_md})
    return "created"


def read(p, default):
    return p.read_text() if p.exists() else default


registry = {}
# company vault
ci = find_or_create_vault_issue("Vault: company", None)
registry["company"] = {"issueId": ci["id"], "identifier": ci["identifier"]}
for key, title, path in (("conventions", "Company conventions", VAULT / "company/conventions.md"),
                         ("repo-radius", "Company repo radius", VAULT / "company/repo-radius.md"),
                         ("decisions", "Company decisions", None)):
    print("company", key, put_doc(ci["id"], key, title, read(path, f"# {title}\n\n(fill in)\n") if path else "# Company decisions\n\nADR-style. Newest first.\n"))

# project vaults
for p in req("GET", f"/api/companies/{C}/projects"):
    key = p.get("urlKey") or re.sub(r"[^a-z0-9]+", "-", p["name"].lower()).strip("-")
    vi = find_or_create_vault_issue(f"Vault: {p['name']}", p["id"])
    registry[key] = {"issueId": vi["id"], "identifier": vi["identifier"], "projectId": p["id"], "name": p["name"]}
    d = VAULT / key
    for dk, title, fname, default in (
        ("goals", f"Goals: {p['name']}", "goals.md", f"# Goals: {p['name']}\n\n{p.get('description') or ''}\n\n## Current goals\n- (fill in)\n"),
        ("conventions", f"Conventions: {p['name']}", "conventions.md", f"# Conventions: {p['name']}\n\n## Stack\n- (fill in)\n"),
        ("repo-radius", f"Repo radius: {p['name']}", "repo-radius.md", f"# Repo radius: {p['name']}\n\n## Allowed by default\n- `src/**`\n"),
        ("history", f"History: {p['name']}", "history.md", f"# History: {p['name']}\n\n| Date | Issue | What happened |\n| --- | --- | --- |\n"),
        ("decisions", f"Decisions: {p['name']}", None, f"# Decisions: {p['name']}\n\nADR-style. Newest first.\n"),
    ):
        print(key, dk, put_doc(vi["id"], dk, title, read(d / fname, default) if fname else default))

# registry doc on company vault issue so agents can find everything in one read
reg_md = "# Vault registry\n\nStanding vault issues. Read documents with `GET /api/issues/{issueId}/documents/{key}`.\n\n| Scope | Issue | Issue id | Docs |\n| --- | --- | --- | --- |\n"
reg_md += f"| company | {registry['company']['identifier']} | {registry['company']['issueId']} | conventions, repo-radius, decisions |\n"
for k, v in registry.items():
    if k == "company":
        continue
    reg_md += f"| {v['name']} (`{k}`) | {v['identifier']} | {v['issueId']} | goals, conventions, repo-radius, history, decisions |\n"
req("PUT", f"/api/issues/{ci['id']}/documents/registry", {"title": "Vault registry", "format": "markdown", "body": reg_md})
print("registry written on", registry["company"]["identifier"])

# rewrite agent instructions: Paperclip documents are canonical
RULE = f"""## Vault resolution (mandatory)

The vault lives in Paperclip as documents on standing "Vault" issues, viewable in the UI. Disk copies are not canonical.

1. Company vault: issue {registry['company']['identifier']} (id `{registry['company']['issueId']}`). Read its `registry` document first: it lists every project's vault issue id. Then read `conventions` and `repo-radius`.
2. Project vault: resolve the current issue's `projectId`, look up the matching row in the registry, then read that vault issue's documents: `goals`, `conventions`, `repo-radius`, `history`, `decisions` via `GET /api/issues/{{vaultIssueId}}/documents/{{key}}`. Company rules apply first; project rules override only when they say so explicitly.
3. Per-task artifacts stay on the task issue itself: Clarifier writes the `scope` document, Planner writes the `plan` document (`PUT /api/issues/{{issueId}}/documents/{{key}}`). These are the logged scopes and plans.
4. On task close, Planner appends one row to the project vault's `history` document (read it, append, PUT the whole body back) and adds a `decisions` entry when a durable decision was made.
5. A project with no vault issue: create issue "Vault: <project name>" in that project with the five documents, add a row to the registry, and say so in a comment.
6. Never put secrets in any vault document.
"""
for a in req("GET", f"/api/companies/{C}/agents"):
    aid = a["id"]
    cur = req("GET", f"/api/agents/{aid}/instructions-bundle/file?path=AGENTS.md&companyId={C}")
    body = cur.get("content") or cur.get("body") or ""
    body = re.sub(r"## Vault resolution \(mandatory\)\n.*?(?=\n## )", RULE.rstrip() + "\n", body, count=1, flags=re.S)
    if "## Vault resolution (mandatory)" not in body:
        body = body.replace("## Operating workflow", RULE + "\n## Operating workflow", 1)
    body = body.replace("and to the vault at <project>/scopes/<issue-identifier>.md. Both must match.", "(the scope document is the vault record).")
    body = body.replace("<project>/plans/<issue-identifier>.md and to the issue document with key `plan`", "the issue document with key `plan` (that is the vault record)")
    req("PUT", f"/api/agents/{aid}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": body})
    print(a["name"], "instructions updated")
print(json.dumps(registry, indent=1))
