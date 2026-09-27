#!/usr/bin/env python3
"""Vault as PARA memory (para-memory-files skill), stored as Paperclip documents on the standing Vault issues.

Per vault issue (company = area, each project = project):
  summary   -- summary.md: quick context, rewritten from active hot/warm facts
  items     -- items.yaml: atomic facts, never deleted, superseded instead
  goals / conventions / repo-radius stay as human-owned reference docs
  history / decisions are retired: their content (if any) is folded into items as facts

Agent rules written into AGENTS.md: read summary first, items on demand; write only critical facts; supersede, never delete.
Idempotent. Runs on the VPS as user paperclip."""
import json, os, re, urllib.request, datetime

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
TODAY = datetime.date.today().isoformat()


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:300]); raise


def get_doc(issue_id, key):
    try:
        return req("GET", f"/api/issues/{issue_id}/documents/{key}")
    except Exception:
        return None


def put_doc(issue_id, key, title, body):
    cur = get_doc(issue_id, key)
    payload = {"title": title, "format": "markdown", "body": body}
    if cur:
        payload["baseRevisionId"] = cur.get("latestRevisionId") or cur.get("revisionId")
    req("PUT", f"/api/issues/{issue_id}/documents/{key}", payload)


def summary_md(kind, name):
    return f"""# {name} — summary

_PARA {kind}. Quick context for agents: load this first, `items` on demand. Rewritten by Planner when 10+ new facts accumulate or weekly, from hot (7d) and warm (30d) facts. Cold facts stay in `items`._

## What this is
- (fill in: one paragraph)

## Current state
- (no facts yet)

## Hard constraints agents must respect
- see `repo-radius` and `conventions`

## Recent decisions
- (none yet)
"""


def items_yaml(name, key, seed):
    head = f"""# items.yaml — atomic facts for {name} (PARA {key})
# Schema per fact:
#   - id: {key}-001
#     fact: "one durable, critical fact"
#     category: decision | constraint | architecture | convention | gotcha | milestone | status
#     timestamp: "YYYY-MM-DD"      # when it became true
#     source: "GRA-123"            # issue or person that established it
#     status: active               # active | superseded
#     superseded_by: null          # id of the newer fact
#     related_entities: []         # e.g. [projects/unberry-ats-dashboard, areas/company]
#     last_accessed: "YYYY-MM-DD"
#     access_count: 0
# Rules: never delete; supersede. Only critical facts (see AGENTS.md "Vault write rule").
"""
    body = "\n".join(seed) if seed else "[]"
    return "```yaml\n" + head + body + "\n```\n"


def fold_legacy(issue_id, key):
    """Turn any non-placeholder lines in legacy history/decisions docs into seed facts."""
    seeds, n = [], 0
    for legacy in ("history", "decisions"):
        d = get_doc(issue_id, legacy)
        if not d:
            continue
        for line in (d.get("body") or "").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("|") or line.startswith("_") or "(fill in)" in line or "newest first" in line.lower() or "ADR-style" in line:
                continue
            if line.startswith("- "):
                line = line[2:]
            n += 1
            seeds.append(f'- id: {key}-{n:03d}\n  fact: "{line.replace(chr(34), chr(39))}"\n  category: {"decision" if legacy == "decisions" else "milestone"}\n  timestamp: "{TODAY}"\n  source: "legacy-{legacy}"\n  status: active\n  superseded_by: null\n  related_entities: []\n  last_accessed: "{TODAY}"\n  access_count: 0')
    return seeds


# ---- vault issues ----
hits = req("GET", f"/api/companies/{C}/issues")
vaults = [h for h in hits if h["title"].startswith("Vault:")]
projects = {p["id"]: p for p in req("GET", f"/api/companies/{C}/projects")}
registry_rows = []
for v in vaults:
    is_company = v["title"] == "Vault: company"
    proj = projects.get(v.get("projectId"))
    name = "company" if is_company else (proj["name"] if proj else v["title"].replace("Vault: ", ""))
    key = "company" if is_company else (proj["urlKey"] if proj else re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"))
    kind = "area (areas/company)" if is_company else f"project (projects/{key})"
    if not get_doc(v["id"], "summary"):
        put_doc(v["id"], "summary", f"Summary: {name}", summary_md(kind, name)); print(v["identifier"], "summary created")
    if not get_doc(v["id"], "items"):
        put_doc(v["id"], "items", f"Items (atomic facts): {name}", items_yaml(name, key, fold_legacy(v["id"], key))); print(v["identifier"], "items created")
    registry_rows.append((name, key, v["identifier"], v["id"], is_company))
    # retire legacy docs (keep content folded into items); delete if they exist
    for legacy in ("history", "decisions"):
        if get_doc(v["id"], legacy):
            try:
                req("DELETE", f"/api/issues/{v['id']}/documents/{legacy}"); print(v["identifier"], legacy, "retired")
            except Exception:
                pass

company = next((r for r in registry_rows if r[4]), None)
if company:
    reg = "# Vault registry (PARA)\n\nRead `summary` first, `items` on demand. `GET /api/issues/{issueId}/documents/{key}`.\n\n| PARA path | Issue | Issue id | Docs |\n| --- | --- | --- | --- |\n"
    reg += f"| areas/company | {company[2]} | {company[3]} | summary, items, conventions, repo-radius |\n"
    for name, key, ident, iid, isc in registry_rows:
        if not isc:
            reg += f"| projects/{key} ({name}) | {ident} | {iid} | summary, items, goals, conventions, repo-radius |\n"
    reg += "\nArchived projects: move the row here under an `archives/` heading when the Paperclip project is archived; docs stay on the issue.\n"
    put_doc(company[3], "registry", "Vault registry", reg); print("registry rewritten")

# ---- agent rules ----
RULE = """## Vault = PARA memory (mandatory)

The vault follows the `para-memory-files` skill, stored as Paperclip documents on the standing Vault issues (registry on the company vault issue). Company vault = `areas/company`; each project vault = `projects/<urlKey>`.

Read (every task): company `summary`, then the project `summary`. Open `items` only when the summary points at something or you need the source of a fact. Also `goals`, `conventions`, `repo-radius` when scoping, planning, or reviewing.

Write rule: write only when you found something **critical** — a fact that would change how a future task is scoped, planned, built, or verified. Examples that qualify: a durable decision, a hard constraint, an architecture fact, a convention actually enforced in the repo, a gotcha that cost real time, a milestone that changes project state. Does NOT qualify: task progress, what you did, anything already in the issue thread, opinions, things that may change next week. When unsure, do not write; mention it in the issue comment instead.

How to write: append one atomic fact to `items` (GET the doc, add a YAML entry with the schema in the file header, PUT with `baseRevisionId`). Never delete or edit a fact; add a new one with `status: active` and mark the old one `status: superseded`, `superseded_by: <new id>`. Reference the issue in `source`. One fact per entry, one sentence.

Summary rewrite (Planner only): when a project's `items` has 10+ facts newer than the summary, or weekly, rewrite `summary` from hot (7d) and warm (30d) active facts, ordered by recency then access_count; cold facts stay only in `items`.
"""
ROLE = {
    "Clarifier": "You write to `items` only for: a product constraint or scope decision the requester made that will bind future tasks; a requester-supplied fact about the product that the vault lacks.",
    "Planner": "You write to `items` for: accepted plan decisions with lasting effect, repo-radius changes accepted by a human, architecture choices, milestones on task close. You own summary rewrites. You also update `goals`/`conventions`/`repo-radius` when a human explicitly asks.",
    "QA": "You write to `items` only for: a reproducible environment or test gotcha that will recur, or a verified behaviour constraint (\"X must never happen\") discovered during testing.",
    "Executor": "You do not write to the vault. Report candidate facts in your issue comment as `Vault candidate: ...`; Planner decides.",
    "CodeReviewer": "You do not write to the vault. Report candidate conventions or gotchas in your review comment as `Vault candidate: ...`; Planner decides.",
}
agents = req("GET", f"/api/companies/{C}/agents")
for a in agents:
    if a["name"] not in ROLE:
        continue
    cur = req("GET", f"/api/agents/{a['id']}/instructions-bundle/file?path=AGENTS.md&companyId={C}")
    body = cur.get("content") or ""
    # replace the previous vault section
    body = re.sub(r"## Vault resolution \(mandatory\)\n.*?(?=\n## )", RULE + "\n### Your write scope\n" + ROLE[a["name"]] + "\n", body, count=1, flags=re.S)
    if "## Vault = PARA memory (mandatory)" not in body:
        body = body.replace("## Operating workflow", RULE + "\n### Your write scope\n" + ROLE[a["name"]] + "\n\n## Operating workflow", 1)
    body = body.replace("On task close, Planner appends one row to the project vault's `history` document (read it, append, PUT the whole body back) and adds a `decisions` entry when a durable decision was made.", "On task close, Planner adds milestone/decision facts to the project vault's `items` (see Vault = PARA memory).")
    body = body.replace("<project>/history.md", "project vault `items`").replace("vault/history.md", "project vault `items`")
    req("PUT", f"/api/agents/{a['id']}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": body})
    print(a["name"], "instructions updated")
