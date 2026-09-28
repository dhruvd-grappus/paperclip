#!/usr/bin/env python3
"""Create or sync a Paperclip project + one git workspace + its PARA vault issue from a directory of markdown docs,
and add a registry row on the company vault. Generic: no project facts live in this script (the public fork must
never carry a roster or repo secret); everything comes from the args and the docs directory.

Usage (on the VPS, as user paperclip):
  add-project.py --name "Aakash Nova" --repo https://bitbucket.org/x/y.git --workspace y [--ref dev] \
                 --description-file desc.md --docs-dir docs/ [--overwrite]
docs/<key>.md → document <key> on the vault issue (summary, items, goals, conventions, repo-radius, rules, identities, …).
Existing documents are kept unless --overwrite. Idempotent."""
import argparse, json, os, urllib.request, urllib.error, datetime, glob

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
TODAY = datetime.date.today().isoformat()

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--repo", required=True)
ap.add_argument("--workspace", required=True)
ap.add_argument("--ref", default=None)
ap.add_argument("--description-file", required=True)
ap.add_argument("--docs-dir", required=True)
ap.add_argument("--overwrite", action="store_true")
a = ap.parse_args()


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
    return "written" if not cur else "overwritten"


desc = open(a.description_file).read()
proj = next((p for p in req("GET", f"/api/companies/{C}/projects") if p["name"] == a.name), None)
if not proj:
    proj = req("POST", f"/api/companies/{C}/projects", {"name": a.name, "description": desc, "status": "in_progress"})
    print("project created", proj["id"])
else:
    req("PATCH", f"/api/projects/{proj['id']}", {"description": desc})
    print("project exists, description synced", proj["id"])
pid = proj["id"]

ws = {"name": a.workspace, "sourceType": "git_repo", "repoUrl": a.repo, "isPrimary": True}
if a.ref:
    ws.update({"repoRef": a.ref, "defaultRef": a.ref})
have = {w["name"]: w for w in req("GET", f"/api/projects/{pid}/workspaces")}
if a.workspace in have:
    req("PATCH", f"/api/projects/{pid}/workspaces/{have[a.workspace]['id']}", ws); print("workspace synced", a.workspace)
else:
    print("workspace created", a.workspace, req("POST", f"/api/projects/{pid}/workspaces", ws)["id"])

proj = req("GET", f"/api/projects/{pid}")
key = proj.get("urlKey") or a.name.lower().replace(" ", "-")
title = f"Vault: {a.name}"
vault = next((i for i in req("GET", f"/api/companies/{C}/issues?projectId={pid}") if i["title"] == title), None)
if not vault:
    vault = req("POST", f"/api/companies/{C}/issues", {
        "title": title, "status": "todo", "priority": "low", "projectId": pid,
        "description": f"Standing vault issue. Documents on this issue are the project's long-term memory (PARA `projects/{key}`). "
                       "Read `rules` first (if present), then `summary`, `items` on demand. Never mark done."})
    print("vault issue created", vault["identifier"])
vid = vault["id"]

docs = sorted(glob.glob(os.path.join(a.docs_dir, "*.md")))
keys = []
for f in docs:
    dk = os.path.splitext(os.path.basename(f))[0]
    keys.append(dk)
    print(vault["identifier"], dk, put_doc(vid, dk, f"{dk.capitalize()}: {a.name}", open(f).read(), a.overwrite))

company = next((i for i in req("GET", f"/api/companies/{C}/issues") if i["title"] == "Vault: company" and not i.get("projectId")), None)
reg = get_doc(company["id"], "registry") if company else None
if not reg:
    print("WARN no company registry doc; add the row by hand")
elif vid in (reg.get("body") or ""):
    print("registry row present")
else:
    row = f"| projects/{key} ({a.name}) | {vault['identifier']} | {vid} | {pid} | {', '.join(keys)} |"
    lines = reg["body"].split("\n")
    first_table_end = next(i for i, l in enumerate(lines) if l.startswith("|") and i + 1 < len(lines) and not lines[i + 1].startswith("|"))
    body = "\n".join(lines[:first_table_end + 1] + [row] + lines[first_table_end + 1:])
    req("PUT", f"/api/issues/{company['id']}/documents/registry",
        {"title": reg.get("title") or "Vault registry", "format": "markdown", "body": body,
         "baseRevisionId": reg.get("latestRevisionId") or reg.get("revisionId")})
    print("registry row added")
print(json.dumps({"projectId": pid, "vault": vault["identifier"], "vaultId": vid, "urlKey": key}))
