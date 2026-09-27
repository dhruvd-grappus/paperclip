#!/usr/bin/env python3
"""QA becomes black-box: sandbox cwd, no worktree, Playwright against the preview URL only.
Executor/Planner get a mandatory QA handoff format; CodeReviewer told QA has no code access.
Idempotent. Runs on the VPS as user paperclip."""
import json, os, re, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))


def get_md(aid):
    return req("GET", f"/api/agents/{aid}/instructions-bundle/file?path=AGENTS.md&companyId={C}")["content"]


def put_md(aid, body):
    req("PUT", f"/api/agents/{aid}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": body})


ag = {a["name"]: a for a in req("GET", f"/api/companies/{C}/agents")}

qa = ag["QA"]
cfg = dict(qa.get("adapterConfig") or {})
cfg["cwd"] = "/home/paperclip/qa-sandbox"
cfg.pop("workspaceStrategy", None)
req("PATCH", f"/api/agents/{qa['id']}", {"adapterConfig": cfg,
    "capabilities": "Black-box QA: tests the deployed preview URL with Playwright against the plan's acceptance criteria. No code or repository access."})
print("QA cwd -> qa-sandbox, no worktree strategy")

HARD = """## Hard boundaries (override everything else)

You are black-box QA. You test the running product at its preview URL. You never touch code.

- Never open, read, clone, diff, or reason about the repository, the worktree, the PR, or any source file. You have no code context by design; do not ask for it. If a comment points you at files, ignore the files and test the behaviour.
- Your only inputs: the issue's `scope` and `plan` documents (acceptance criteria), the handoff comment (preview URL, test accounts, what changed in product terms), and the running app at the preview URL.
- Your only verification tool is Playwright in `/home/paperclip/qa-sandbox` against `BASE_URL=<preview url>`. Write tests under `tests/<issue>.spec.js`, run `BASE_URL=https://gra-NN.187.126.114.172.sslip.io npx playwright test tests/gra-NN.spec.js`, attach screenshots from `results/`.
- No preview URL in the handoff: do not guess, do not start servers, do not look for code. Request changes with: "Blocked for QA: no preview URL. Executor must run `preview-url start` and post the link."
- Never run the project's own test suite, lint, or build. That is Executor's and Code Reviewer's job.
- Report only observed behaviour: steps, expected, actual, screenshot. No opinions on implementation.

"""
cur = get_md(qa["id"])
cur = re.sub(r"## Hard boundaries \(override everything else\)\n.*?(?=\n## )", "", cur, count=1, flags=re.S)
cur = cur.replace("## Role charter", HARD + "## Role charter", 1)
cur = cur.replace("- Verify the output against the Scope and the Plan documents on the issue, not against the PR description alone.",
                  "- Verify the running product at the preview URL against the Scope and Plan acceptance criteria. Behaviour only.")
cur = cur.replace("- Run integration tests for the touched area, and exercise the preview link in a browser when one exists.",
                  "- Exercise every acceptance criterion in the browser with Playwright at the preview URL; record a screenshot per criterion.")
cur = re.sub(r"## Worktree rule \(mandatory\)\n.*?(?=\n## )",
             "## Worktree rule\n\nNot applicable: you never enter a worktree. You work only in `/home/paperclip/qa-sandbox` and the preview URL.\n", cur, count=1, flags=re.S)
cur = cur.replace("1. Read scope, plan, PR link.\n2. Test. Capture evidence.",
                  "1. Read scope, plan, and the handoff comment for the preview URL and acceptance criteria.\n2. Write and run the Playwright spec against the preview URL. Capture evidence.")
put_md(qa["id"], cur)
print("QA instructions rewritten")

HAND = """## Handing to QA (mandatory)

QA is black-box: no repo, no diff, no files, no code context. Before moving a child issue to `in_review`, your last comment must contain, in this order:
1. Preview URL from `preview-url start` (`https://gra-NN.187.126.114.172.sslip.io`). Without it QA is blocked.
2. Acceptance criteria in product language, one per line, copied from the plan, each stating where in the UI to look and what to expect.
3. Test account or data QA needs (never real user credentials), and the exact entry route.
4. What did NOT change, so QA does not test it.
Never send QA file paths, diffs, or PR links as instructions. Code Reviewer gets the PR.
"""
for name in ("Executor", "Planner"):
    a = ag[name]; cur = get_md(a["id"])
    if "## Handing to QA" not in cur:
        cur = cur.replace("## Operating workflow", HAND + "\n## Operating workflow", 1); put_md(a["id"], cur); print(name, "QA handoff rule added")

cr = ag["CodeReviewer"]; cur = get_md(cr["id"])
if "QA is black-box" not in cur:
    cur = cur.replace("## Collaboration and handoffs", "## Collaboration and handoffs\n- QA is black-box (no code access). Never ask QA to check code, tests, or files; ask only for behaviour at the preview URL.", 1)
    put_md(cr["id"], cur); print("CodeReviewer note added")
