#!/usr/bin/env python3
"""Single-agent pipeline (2026-09-26): Clarifier does everything via company skills.

Why: five agents meant five instruction files drifting apart, cross-agent
handoffs, id tables, and a Slack-bound issue that could never be reassigned.
One agent with role skills (`pc-lite`, `scope`, `build`, `review`, `qa`, `memory`)
removes all of that; the issue title prefix picks the skill.

What it does (idempotent; refuses to run while any heartbeat run is live
unless --force):
  1. Company skills: re-import every dir under /home/paperclip/skills/<slug>
     as managed local skills via `paperclipai skills create` (old copy removed
     first; local-path import is refused outside workspace roots), then `replace` Clarifier's desired skills
     with exactly those.
  2. Clarifier: PUT AGENTS.md from paperclip/agents/clarifier.md, PATCH
     title/adapterConfig (timeout 1500s, grace 30s, 150 turns, opus).
  3. Pause Executor, QA, CodeReviewer, ProductGuide (reversible) and move
     their open issues to Clarifier.
  4. Host: deny-list in ~/clarifier-sandbox/.claude/settings.json,
     ~/qa-sandbox/playwright.config.js -> system Chromium.
Run on the VPS as user paperclip:  python3 single-agent.py [--force]
Rollback: paperclip/backups/multi-agent-2026-09-26/ (AGENTS.md + agent
records) and `POST /api/agents/{id}/resume` for the paused agents.
"""
import json, os, subprocess, sys, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
CL = "221ca6db-6cf1-49ff-bdf1-270a53c201f9"
OTHERS = {"Executor": "921c717a-3a8d-4aca-be57-5fe242854b9d", "QA": "3e7df85b-2d03-4a67-ad80-9400adc36157",
          "CodeReviewer": "04dd614b-55d2-49eb-8911-413d1d3d73f9", "ProductGuide": "3db0657b-e44c-40c3-a0a5-8e525c5a8abf"}
SKILLS_DIR = os.path.expanduser("~/skills")
SKILL_SLUGS = ["pc-lite", "scope", "build", "review", "qa", "memory", "env"]
EXTRA_SKILLS = ["paperclipai/paperclip/para-memory-files",  # bundled; used by the memory skill
                "juliusbrussee/caveman/caveman"]            # GitHub import; terse internal comments
DROP_SLUGS = ["cavecrew"]  # comes along with the caveman import; not needed
HERE = os.path.dirname(os.path.abspath(__file__))
AGENTS_MD = os.path.join(HERE, "agents", "clarifier.md")
MARK = "<!-- single-agent v15 -->"
FORCE = "--force" in sys.argv


def req(m, p, body=None, ok404=False):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        raw = urllib.request.urlopen(r, timeout=120).read()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if ok404 and e.code == 404:
            return None
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


def cli(*args):
    out = subprocess.run(["paperclipai", *args, "-C", C, "--api-base", B, "--api-key", K, "--json"], capture_output=True, text=True)
    if out.returncode != 0:
        print("CLI ERR", args, out.stdout[-400:], out.stderr[-400:]); raise SystemExit(1)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"raw": out.stdout}


live = req("GET", f"/api/companies/{C}/live-runs")
if live and not FORCE:
    print("live runs:", [(r.get("agentId", "")[:8], r.get("status")) for r in live], "- retry later or --force"); sys.exit(1)

# ---- 1. skills --------------------------------------------------------------
existing = {s["slug"]: s for s in req("GET", f"/api/companies/{C}/skills")}
req("POST", f"/api/agents/{CL}/skills/sync", {"mode": "replace", "desiredSkills": []})
keys = []
for slug in SKILL_SLUGS:
    path = os.path.join(SKILLS_DIR, slug)
    assert os.path.isfile(os.path.join(path, "SKILL.md")), path
    if slug in existing:
        cli("skills", "remove", existing[slug]["id"], "--yes")
    txt = open(os.path.join(path, "SKILL.md")).read()
    parts = txt.split("---\n", 2)                      # frontmatter -> description; rest -> body
    assert len(parts) == 3, f"{slug}: SKILL.md needs a frontmatter block"
    desc = ""
    for line in parts[1].splitlines():
        if line.startswith("description:"):
            desc = line.split(":", 1)[1].strip()
    body_path = f"/tmp/skill-{slug}.md"; open(body_path, "w").write(parts[2])
    res = cli("skills", "create", "--name", slug, "--slug", slug, "--description", desc, "--body-file", body_path)
    key = res.get("key") or res.get("id")
    assert key and res.get("slug") == slug, f"create of {slug} failed: {json.dumps(res)[:300]}"
    keys.append(key); print("skill", slug, "->", key)
have = {x["key"]: x for x in req("GET", f"/api/companies/{C}/skills")}
if "juliusbrussee/caveman/caveman" not in have:
    cli("skills", "import", "juliusbrussee/caveman/caveman"); print("caveman imported")
for x in req("GET", f"/api/companies/{C}/skills"):
    if x["slug"] in DROP_SLUGS:
        cli("skills", "remove", x["id"], "--yes"); print("removed", x["slug"])
keys += EXTRA_SKILLS
sync = req("POST", f"/api/agents/{CL}/skills/sync", {"mode": "replace", "desiredSkills": keys})
got = sorted(sync.get("desiredSkills") or [])
assert set(keys) <= set(got), ("desiredSkills mismatch", got, keys)  # adapter re-adds the required base `paperclip` skill
print("Clarifier desiredSkills:", got)

# ---- 2. Clarifier instructions + config ------------------------------------
new_md = open(AGENTS_MD).read()
assert MARK in new_md
req("PUT", f"/api/agents/{CL}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new_md})
back = req("GET", f"/api/agents/{CL}/instructions-bundle/file?companyId={C}&path=AGENTS.md").get("content") or ""
assert back == new_md, "AGENTS.md readback mismatch"
print("Clarifier AGENTS.md:", len(new_md), "bytes")
req("PATCH", f"/api/agents/{CL}", {"title": "Pipeline Agent",
    "adapterConfig": {"timeoutSec": 1500, "graceSec": 30, "maxTurnsPerRun": 150, "model": "claude-opus-5"}})
a = req("GET", f"/api/agents/{CL}")
ac = a["adapterConfig"]
assert ac.get("timeoutSec") == 1500 and ac.get("maxTurnsPerRun") == 150 and ac.get("cwd") == "/home/paperclip/clarifier-sandbox", ac
print("Clarifier config:", {k: ac.get(k) for k in ("cwd", "model", "timeoutSec", "graceSec", "maxTurnsPerRun")})

# ---- 3. park the other agents ------------------------------------------------
for name, aid in OTHERS.items():
    ag = req("GET", f"/api/agents/{aid}", ok404=True)
    if not ag or ag.get("status") == "terminated":
        print(name, "absent"); continue
    for i in req("GET", f"/api/companies/{C}/issues?assigneeAgentId={aid}"):
        if i["status"] in ("done", "cancelled"):
            continue
        req("PATCH", f"/api/issues/{i['id']}", {"assigneeAgentId": CL,
            "comment": f"Single-agent pipeline: {name} retired, Clarifier continues from the latest comment."})
        print("  moved", i["identifier"], i["status"], "->", "Clarifier")
    if ag.get("status") != "paused":
        req("POST", f"/api/agents/{aid}/pause", {})
        print(name, "paused:", req("GET", f"/api/agents/{aid}").get("status"))
    else:
        print(name, "already paused")

# ---- 4. host files -----------------------------------------------------------
sb = os.path.expanduser("~/clarifier-sandbox/.claude"); os.makedirs(sb, exist_ok=True)
settings = {"permissions": {"deny": [
    "WebSearch", "WebFetch",
    "Bash(npm run dev:*)", "Bash(npm run dev)", "Bash(npx next dev:*)", "Bash(next dev:*)", "Bash(pnpm dev:*)", "Bash(yarn dev:*)",
    "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git reset --hard:*)",
    "Bash(chromium-browser:*)", "Bash(chromium:*)", "Bash(google-chrome:*)",
]}}
with open(os.path.join(sb, "settings.json"), "w") as f:
    json.dump(settings, f, indent=2); f.write("\n")
pw = os.path.expanduser("~/qa-sandbox/playwright.config.js")
open(pw, "w").write('''// QA sandbox: tests run only against the public preview URL passed as BASE_URL.
// System Chromium: the bundled Playwright browser does not launch on this host.
module.exports = {
  testDir: "tests",
  timeout: 60000,
  outputDir: "results",
  reporter: [["list"], ["json", { outputFile: "results/last.json" }]],
  use: {
    baseURL: process.env.BASE_URL,
    headless: true,
    screenshot: "on",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    launchOptions: { executablePath: "/usr/bin/chromium-browser" },
  },
};
''')
print("host files written:", os.path.join(sb, "settings.json"), pw)
print("DONE")
