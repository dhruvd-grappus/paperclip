#!/usr/bin/env python3
"""Retire Planner; Clarifier becomes head of org (scope + plan + breakdown + gates).

Why (2026-09-26): scope and plan documents cost a full run each; two lead
agents doubled handoffs. Clarifier now scopes AND plans as short comments,
gets human approval, breaks work into small Executor children, runs the link
gate. Planner is backed up in paperclip/backups/planner-2026-09-25/ and then
terminated (irreversible in Paperclip; recreate from the backup via
paperclip-create-agent if ever needed).

Steps (idempotent, each checks before acting; agents with a live run are
skipped and the script exits 1 so you re-run):
  1. Clarifier: PUT AGENTS.md from paperclip/agents/clarifier.md (marker
     `clarifier-lead v2`; v2 = plan only for epics, approval only for risky plans), PATCH role ceo / title / reportsTo null, add the
     plan-breakdown skill to paperclipSkillSync.
  2. Executor, QA, CodeReviewer, ProductGuide: reportsTo Clarifier; AGENTS.md
     drops the Planner id row, Planner -> Clarifier, scope/plan documents ->
     child description (marker `no-planner v1`).
  3. Planner's open issues -> Clarifier with a comment.
  4. Planner: terminate (only when it has no live run and steps 1-3 done).
Run on the VPS as user paperclip: python3 merge-planner-into-clarifier.py [--no-terminate]
"""
import json, os, re, sys, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
CL = "221ca6db-6cf1-49ff-bdf1-270a53c201f9"
PL = "2b1f9702-1d51-489a-92e2-5cb5389bcca1"
EX = "921c717a-3a8d-4aca-be57-5fe242854b9d"
QA = "3e7df85b-2d03-4a67-ad80-9400adc36157"
CR = "04dd614b-55d2-49eb-8911-413d1d3d73f9"
PG = "3db0657b-e44c-40c3-a0a5-8e525c5a8abf"
LEAD_MARK = "<!-- clarifier-lead v2 -->"
MARK = "<!-- no-planner v1 -->"
HERE = os.path.dirname(os.path.abspath(__file__))
CLARIFIER_MD = os.path.join(HERE, "agents", "clarifier.md")
TERMINATE = "--no-terminate" not in sys.argv


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r, timeout=60))
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


def get_md(aid):
    return req("GET", f"/api/agents/{aid}/instructions-bundle/file?companyId={C}&path=AGENTS.md").get("content") or ""


def put_md(aid, content):
    req("PUT", f"/api/agents/{aid}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": content})
    assert content[:200] == get_md(aid)[:200], "readback mismatch"


live = {r.get("agentId") for r in req("GET", f"/api/companies/{C}/live-runs")}
agents = {a["id"]: a for a in req("GET", f"/api/companies/{C}/agents")}
pending = 0

# ---- 1. Clarifier ---------------------------------------------------------
new_cl = open(CLARIFIER_MD).read()
assert LEAD_MARK in new_cl
if LEAD_MARK in get_md(CL):
    print("Clarifier AGENTS.md already lead version")
elif CL in live:
    pending += 1; print("Clarifier has a live run; AGENTS.md not replaced, retry later")
else:
    put_md(CL, new_cl); print("Clarifier AGENTS.md replaced")

a = agents[CL]
patch = {}
if a.get("role") != "ceo": patch["role"] = "ceo"
if a.get("title") != "Scope & Plan Lead": patch["title"] = "Scope & Plan Lead"
if a.get("reportsTo") is not None: patch["reportsTo"] = None
skills = (a.get("adapterConfig") or {}).get("paperclipSkillSync", {}).get("desiredSkills") or []
want = ["paperclipai/paperclip/paperclip", "paperclipai/paperclip/para-memory-files",
        "paperclipai/paperclip/paperclip-converting-plans-to-tasks"]
if set(want) - set(skills):
    patch["adapterConfig"] = {"paperclipSkillSync": {"desiredSkills": sorted(set(skills) | set(want))}}
if patch:
    if CL in live and "adapterConfig" in patch:
        pending += 1; print("Clarifier live; adapterConfig change deferred")
        patch.pop("adapterConfig")
    if patch:
        req("PATCH", f"/api/agents/{CL}", patch); print("Clarifier patched:", list(patch))
else:
    print("Clarifier record already head of org")

# ---- 2. other agents ------------------------------------------------------
DOC_EDITS = {
    EX: [
        ("- Work only on child issues assigned to you. Each carries a scope, a plan, and a repo radius. Read all three before touching code.",
         "- Work only on child issues assigned to you. The child's `description` is self-contained: scope, your breakdown item with acceptance criteria, and the repo radius. Read it before touching code. There are no `scope`/`plan` documents; if the description lacks the radius or criteria, read the parent's newest `Plan (v…)` comment, and if still missing mark `blocked` with owner = Clarifier."),
        ("1. Read scope, plan, repo radius, conventions.",
         "1. Read the child description (scope, item, acceptance criteria, repo radius) and conventions."),
        ("2. Acceptance criteria in product language, one per line, copied from the plan, each stating where in the UI to look and what to expect.",
         "2. Acceptance criteria in product language, one per line, copied from the child description, each stating where in the UI to look and what to expect."),
        ("Keys used here: `scope`, `plan` on task issues; `goals`, `conventions`, `repo-radius`, `history`, `decisions` on vault issues.",
         "Keys used here: vault issue documents only (`items`, `goals`, `conventions`, `repo-radius`). Task issues carry no documents: scope and plan are comments; your child description holds what you need."),
    ],
    QA: [
        ("- Your only inputs: the issue's `scope` and `plan` documents (acceptance criteria), the handoff comment (preview URL, test accounts, what changed in product terms), and the running app at the preview URL.",
         "- Your only inputs: the handoff (your sub-issue description: preview URL, acceptance criteria, test accounts, what changed in product terms), the parent child issue's `description` (scope and acceptance criteria), and the running app at the preview URL. There are no `scope`/`plan` documents."),
        ("- Verify the running product at the preview URL against the Scope and Plan acceptance criteria. Behaviour only.",
         "- Verify the running product at the preview URL against the acceptance criteria in the handoff and the scope in the parent child's description. Behaviour only."),
        ("- Nice to have: when Planner asks, review the Clarifier-to-Planner handoff before code exists and flag scope that the plan does not cover.\n", ""),
        ("Read the parent's `scope` and `plan` documents (`parentId`) for context.",
         "Read the parent child issue's `description` (`parentId`) for the scope and full acceptance criteria."),
        ("Keys used here: `scope`, `plan` on task issues; `goals`, `conventions`, `repo-radius`, `history`, `decisions` on vault issues.",
         "Keys used here: vault issue documents only (`items`, `goals`, `conventions`, `repo-radius`). Task issues carry no documents."),
    ],
    CR: [
        ("Keys used here: `scope`, `plan` on task issues; `goals`, `conventions`, `repo-radius`, `history`, `decisions` on vault issues.",
         "Keys used here: vault issue documents only (`items`, `goals`, `conventions`, `repo-radius`). Task issues carry no documents: scope and plan are comments on the parent."),
    ],
    PG: [],
}
for aid in (EX, QA, CR, PG):
    name = agents[aid]["name"]
    if agents[aid].get("reportsTo") != CL:
        req("PATCH", f"/api/agents/{aid}", {"reportsTo": CL}); print(name, "reportsTo -> Clarifier")
    cur = get_md(aid)
    if MARK in cur:
        print(name, "AGENTS.md already done"); continue
    if aid in live:
        pending += 1; print(name, "has a live run, AGENTS.md deferred"); continue
    new = cur
    ok = True
    for old, rep in DOC_EDITS[aid]:
        if new.count(old) != 1:
            ok = False; print(name, "anchor count", new.count(old), "for", repr(old[:70]))
        else:
            new = new.replace(old, rep, 1)
    if not ok:
        pending += 1; print(name, "SKIPPED: anchors changed"); continue
    new = re.sub(r"^\| Planner \| `" + PL + r"` \|\n", "", new, flags=re.M)
    new = new.replace("Planner (Delivery Lead)", "Clarifier (Scope & Plan Lead)")
    new = new.replace("Planner", "Clarifier")
    assert PL not in new, name + " still references Planner id"
    new = new.replace("## Agent ids", MARK + "\n## Agent ids", 1) if "## Agent ids" in new else MARK + "\n" + new
    put_md(aid, new); print(name, "AGENTS.md updated")

# ---- 3. Planner's open issues --------------------------------------------
for i in req("GET", f"/api/companies/{C}/issues?assigneeAgentId={PL}"):
    if i["status"] in ("done", "cancelled"):
        continue
    req("PATCH", f"/api/issues/{i['id']}", {"assigneeAgentId": CL, "comment": "Planner retired; Clarifier now owns scope, plan and gates. Continuing from the latest comment and any open card."})
    print("reassigned", i["identifier"], i["status"])

# ---- 4. terminate Planner -------------------------------------------------
pl = agents.get(PL)
if pl is None or pl.get("status") == "terminated":
    print("Planner already gone")
elif pending:
    print(f"{pending} step(s) pending; not terminating Planner yet. Re-run.")
elif PL in live:
    print("Planner has a live run; re-run later to terminate")
elif not TERMINATE:
    print("--no-terminate: Planner left in place")
else:
    req("POST", f"/api/agents/{PL}/terminate", {})
    print("Planner terminated:", req("GET", f"/api/agents/{PL}").get("status"))

sys.exit(1 if pending else 0)
