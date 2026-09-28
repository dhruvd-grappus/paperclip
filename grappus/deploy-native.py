#!/usr/bin/env python3
"""Deploy the single-agent pipeline on the native runner (2026-09-27, pipeline v16+).

Run on the VPS as user paperclip from /home/paperclip/deploy after `make deploy` copied
skills/, agents/clarifier.md, vps/ there. Refuses to run while any heartbeat run is live (--force overrides).

  1. Stamp: reads `<!-- pipeline vN -->` from agents/clarifier.md and writes the same stamp as the first
     body line of every skills/<slug>/SKILL.md, then installs them to /home/paperclip/skills (the agent
     reads them by absolute path; no Paperclip skill registration, no runtime-skills hashes).
  2. Host helpers: vps/build-start -> /usr/local/bin/build-start (via sudo-less copy to ~/bin fallback),
     vps/native-token.sh -> ~/native-token.sh, vps/runner-shim.sh -> ~/runner-shim.sh, vps/pc -> ~/pc.
  3. Clarifier: PUT AGENTS.md; PATCH adapter to paperclip_runner / acpx / claude with the pipeline config;
     run native-token.sh so CLAUDE_CODE_OAUTH_TOKEN is present.
  4. Prune stale runtime-skills hash dirs (legacy leftovers) and stale skill dirs (keeping skills-sync's
     UI manifest), then run skills-sync.sh so UI-added skills appear immediately.
"""
import json, os, re, shutil, subprocess, sys, urllib.request

B = "https://187.126.114.172.sslip.io"
C = "d255c3a4-2066-4d81-8c40-862ad8208963"
CL = "221ca6db-6cf1-49ff-bdf1-270a53c201f9"
HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
K = json.load(open(f"{HOME}/.paperclip/auth.json"))["credentials"][B]["token"]
FORCE = "--force" in sys.argv
SLUGS = ["pc-lite", "scope", "build", "review", "qa", "memory", "env", "figma", "mobile"]


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    try:
        raw = urllib.request.urlopen(r, timeout=120).read()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print("ERR", m, p, e.code, e.read().decode()[:400]); raise


live = req("GET", f"/api/companies/{C}/live-runs")
if live and not FORCE:
    print("live runs:", [(r.get("agentId", "")[:8], r.get("status")) for r in live], "- retry later or --force"); sys.exit(1)

agents_md = open(os.path.join(HERE, "agents", "clarifier.md")).read()
m = re.search(r"<!-- pipeline (v\d+) -->", agents_md)
assert m, "agents/clarifier.md needs a <!-- pipeline vN --> stamp"
VER = m.group(1)
print("pipeline", VER)

# ---- 1. skills ----------------------------------------------------------------
# Core skills are written to both places: the directory the agent reads by absolute path, and the
# Paperclip company skills store, so the UI shows the live text and no stale copy survives there.
dst_root = f"{HOME}/skills"
store_root = f"{HOME}/.paperclip/instances/default/skills/{C}"
os.makedirs(dst_root, exist_ok=True)
os.makedirs(store_root, exist_ok=True)
for slug in SLUGS:
    src = os.path.join(HERE, "skills", slug, "SKILL.md")
    txt = open(src).read()
    parts = txt.split("---\n", 2)
    assert len(parts) == 3, f"{slug}: needs frontmatter"
    body = parts[2].lstrip("\n")
    body = re.sub(r"^<!-- pipeline v\d+ -->\n+", "", body)
    stamped = f"---\n{parts[1]}---\n<!-- pipeline {VER} -->\n\n{body}"
    for root in (dst_root, store_root):
        os.makedirs(f"{root}/{slug}", exist_ok=True)
        open(f"{root}/{slug}/SKILL.md", "w").write(stamped)
    print("skill", slug, len(stamped), "bytes")
# stale dirs: keep core slugs, the bundled para-memory-files, and anything skills-sync installed
# from the UI (its manifest), so a deploy never deletes a skill added in the Paperclip UI.
ui_synced = set()
try:
    ui_synced = set(open(f"{HOME}/.skills-synced.json").read().split())
except FileNotFoundError:
    pass
for x in [x for x in os.listdir(dst_root) if x not in SLUGS and x != "para-memory-files" and x not in ui_synced]:
    print("removing stale skill dir", x); shutil.rmtree(f"{dst_root}/{x}", ignore_errors=True)

# ---- 2. host helpers ----------------------------------------------------------------
vps = os.path.join(HERE, "vps")
for name, dst in [("native-token.sh", f"{HOME}/native-token.sh"), ("runner-shim.sh", f"{HOME}/runner-shim.sh"), ("pc", f"{HOME}/pc")]:
    p = os.path.join(vps, name)
    if os.path.isfile(p):
        shutil.copyfile(p, dst); os.chmod(dst, 0o755); print("helper", dst)
bs = os.path.join(vps, "build-start")
if os.path.isfile(bs):
    for target in ["/usr/local/bin/build-start", f"{HOME}/.local/bin/build-start"]:
        try:
            shutil.copyfile(bs, target); os.chmod(target, 0o755); print("helper", target); break
        except PermissionError:
            continue

# ---- 3. Clarifier ----------------------------------------------------------------
req("PUT", f"/api/agents/{CL}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": agents_md})
print("AGENTS.md put", len(agents_md), "bytes")
agent = req("GET", f"/api/agents/{CL}")
cfg = {
    "provider": "acpx", "acpxAgent": "claude", "acpxPermissionMode": "approve-all",
    "model": "claude-opus-5", "cwd": "/home/paperclip/clarifier-sandbox",
    "timeoutSec": 1500, "graceSec": 30, "maxTurnsPerRun": 150,
}
body = {"adapterConfig": cfg}
if agent.get("adapterType") != "paperclip_runner":
    body["adapterType"] = "paperclip_runner"
res = req("PATCH", f"/api/agents/{CL}", body)
print("Clarifier adapter:", res.get("adapterType"), {k: res.get("adapterConfig", {}).get(k) for k in ["provider", "acpxAgent", "acpxPermissionMode", "model", "timeoutSec", "maxTurnsPerRun"]})
out = subprocess.run(["bash", f"{HOME}/native-token.sh", CL], capture_output=True, text=True, env={**os.environ, "FORCE": "1"})
print("token sync:", (out.stdout + out.stderr).strip()[-300:])

# ---- 4. prune legacy runtime-skills ----------------------------------------------------------------
rs = f"{HOME}/.paperclip/instances/default/companies/{C}/acp-engine/agents/{CL}/runtime-skills"
if os.path.isdir(rs):
    for sub in ["claude"]:
        p = os.path.join(rs, sub)
        if os.path.isdir(p):
            for h in os.listdir(p):
                shutil.rmtree(os.path.join(p, h), ignore_errors=True)
    for h in os.listdir(rs):
        if h.startswith("stale-"):
            shutil.rmtree(os.path.join(rs, h), ignore_errors=True)
    print("runtime-skills pruned")
# ---- 5. UI skills ----------------------------------------------------------------
sync = f"{HOME}/skills-sync.sh"
if os.path.isfile(sync):
    s = subprocess.run(["bash", sync], capture_output=True, text=True)
    print("skills-sync:", (s.stdout + s.stderr).strip() or "no change")
print("DONE", VER)
