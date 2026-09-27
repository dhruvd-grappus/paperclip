#!/usr/bin/env python3
"""Make the vault project-nested on the hosted instance and rewrite agent instructions to match.
Layout:
  vault/README.md
  vault/company/{conventions.md,repo-radius.md,decisions/}
  vault/<project-urlKey>/{goals.md,conventions.md,repo-radius.md,history.md,scopes/,plans/,decisions/}
Runs on the VPS as user paperclip."""
import json, os, re, shutil, urllib.request, pathlib

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
VAULT = pathlib.Path(f"/home/paperclip/.paperclip/instances/default/companies/{C}/vault")
LEGACY = pathlib.Path("/home/paperclip/vault")


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))


def write(p, text, overwrite=False):
    p.parent.mkdir(parents=True, exist_ok=True)
    if overwrite or not p.exists():
        p.write_text(text)


README = """# Project vault

Shared memory for agents. One folder per Paperclip project, keyed by the project's `urlKey`. `company/` holds rules that apply to every project.

| Path | Holds | Written by |
| --- | --- | --- |
| `company/conventions.md` | Company-wide code and design conventions | Humans |
| `company/repo-radius.md` | Company-wide never-touch zones | Humans |
| `company/decisions/` | Cross-project decisions | Planner or humans |
| `<project>/goals.md` | Why the project exists, current goals | Humans |
| `<project>/conventions.md` | Project-specific conventions, design language, stack | Humans; agents propose |
| `<project>/repo-radius.md` | Default allowed / forbidden paths for this repo | Humans; Planner narrows per task |
| `<project>/history.md` | Dated log, one row per shipped task or decision | Agents on task close |
| `<project>/scopes/<issue>.md` | Scope per task | Clarifier |
| `<project>/plans/<issue>.md` | Plan per task | Planner |
| `<project>/decisions/` | ADR-style decisions for this project | Planner or humans |

Resolution rule for agents: issue → `projectId` → `GET /api/projects/{id}` → `urlKey` → `vault/<urlKey>/`. Read `company/` first, then the project folder. Project rules override company rules only when they say so explicitly.

Never store secrets here.
"""

GOALS = "# Goals: {name}\n\n{desc}\n\n## Current goals\n- (fill in)\n"
CONV = """# Conventions: {name}

Company rules in `../company/conventions.md` apply first. Add here only what is specific to this project.

## Stack
- (fill in)

## Code
- Follow existing patterns in the repo before inventing new ones.
- Reuse existing components, helpers, utilities. Search before writing.

## Design language
- (fill in: design system, tokens, component library)
"""
RADIUS = """# Repo radius: {name}

Company never-touch zones in `../company/repo-radius.md` apply first.

## Allowed by default
- `src/**`
- `tests/**`
- `docs/**`

## Needs explicit approval in the plan
- (fill in per repo)
"""
HISTORY = "# History: {name}\n\nNewest first. One row per shipped task or decision.\n\n| Date | Issue | What happened |\n| --- | --- | --- |\n"
COMPANY_CONV = """# Company conventions

Apply to every project unless the project's own `conventions.md` overrides explicitly.

## Code
- Small, focused commits with descriptive messages.
- Tests accompany behaviour changes.
- Reuse before writing. Search the repo and design system first.

## Reviews
- Every PR needs QA findings and Code Reviewer sign-off before a human is asked to review the link.

## Process
- Nothing is built before a human accepts the plan.
- Every plan and scope is logged in the vault before approval is requested.
"""
COMPANY_RADIUS = """# Company repo radius

Never without explicit approval in an accepted plan, in any project:
- CI / deploy config (`.github/**`, `Dockerfile`, `infra/**`)
- Secrets, env files
- Database migrations
- Auth / permissions code
- Billing / payment code
"""

# 1. company folder
write(VAULT / "README.md", README, overwrite=True)
write(VAULT / "company" / "conventions.md", COMPANY_CONV)
write(VAULT / "company" / "repo-radius.md", COMPANY_RADIUS)
(VAULT / "company" / "decisions").mkdir(parents=True, exist_ok=True)

# 2. per-project folders
projects = req("GET", f"/api/companies/{C}/projects")
keys = []
for p in projects:
    key = p.get("urlKey") or re.sub(r"[^a-z0-9]+", "-", p["name"].lower()).strip("-")
    keys.append((key, p["name"]))
    d = VAULT / key
    write(d / "goals.md", GOALS.format(name=p["name"], desc=p.get("description") or "(no description in Paperclip yet)"))
    write(d / "conventions.md", CONV.format(name=p["name"]))
    write(d / "repo-radius.md", RADIUS.format(name=p["name"]))
    write(d / "history.md", HISTORY.format(name=p["name"]))
    for sub in ("scopes", "plans", "decisions"):
        (d / sub).mkdir(parents=True, exist_ok=True)

# 3. retire flat legacy files at vault root
for f in ("conventions.md", "goals.md", "history.md", "repo-radius.md"):
    fp = VAULT / f
    if fp.exists():
        fp.rename(VAULT / "company" / f"legacy-{f}") if not (VAULT / "company" / f"legacy-{f}").exists() else fp.unlink()
for sub in ("scopes", "plans", "decisions"):
    sp = VAULT / sub
    if sp.exists() and not any(sp.iterdir()):
        sp.rmdir()

# 4. legacy /home/paperclip/vault -> symlink to canonical
if LEGACY.exists() and not LEGACY.is_symlink():
    shutil.rmtree(LEGACY)
if not LEGACY.exists():
    LEGACY.symlink_to(VAULT)

print("vault projects:", keys)

# 5. rewrite agent instructions: vault path -> project-nested resolution
VAULT_RULE = f"""## Vault resolution (mandatory)

The vault is project-nested at `{VAULT}`. Resolve the folder for every issue: issue `projectId` → `GET /api/projects/{{projectId}}` → `urlKey` → `{VAULT}/<urlKey>/`. Read `{VAULT}/company/` first (company-wide conventions and never-touch zones), then the project folder (`goals.md`, `conventions.md`, `repo-radius.md`, `history.md`, `scopes/`, `plans/`, `decisions/`). Write scopes to `<project>/scopes/<issue-identifier>.md`, plans to `<project>/plans/<issue-identifier>.md`, history rows to `<project>/history.md`. If the project folder does not exist, create it from the layout in `{VAULT}/README.md` and say so in a comment. Never read or write vault files outside the issue's project folder and `company/`.
"""
agents = req("GET", f"/api/companies/{C}/agents")
for a in agents:
    aid = a["id"]
    cur = req("GET", f"/api/agents/{aid}/instructions-bundle/file?path=AGENTS.md&companyId={C}")
    body = cur.get("content") or cur.get("body") or ""
    # replace any flat vault path mentions
    body = re.sub(r"(the project vault at |vault at |at )?" + re.escape(str(VAULT)) + r"(/[A-Za-z0-9_.-]+)*", f"the vault (see Vault resolution)", body)
    body = body.replace("/home/paperclip/vault", str(VAULT))
    body = body.replace("vault/scopes/<issue-identifier>.md", "<project>/scopes/<issue-identifier>.md")
    body = body.replace("vault/plans/<issue-identifier>.md", "<project>/plans/<issue-identifier>.md")
    body = body.replace("vault/history.md", "<project>/history.md").replace("vault/repo-radius.md", "<project>/repo-radius.md and company/repo-radius.md").replace("vault/conventions.md", "<project>/conventions.md and company/conventions.md")
    if "## Vault resolution (mandatory)" not in body:
        marker = "## Operating workflow"
        body = body.replace(marker, VAULT_RULE + "\n" + marker, 1) if marker in body else body + "\n" + VAULT_RULE
    req("PUT", f"/api/agents/{aid}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": body})
    print(a["name"], "instructions updated")
