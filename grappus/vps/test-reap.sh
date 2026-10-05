#!/usr/bin/env bash
# Kill test runs (vitest, jest, mocha, playwright test) of this user older than TEST_MAX_MIN, with their
# whole process tree. Agent runs end (25 min, QA 45 min) but a test runner they started can outlive them as
# an orphan. QA's own playwright runs fit under the 50-min default.
# Why: 2026-10-05 two orphaned `vitest run` of the Paperclip server suite ran 7 h at 1.4 GB each; with the
# previews they filled RAM and swap, load hit 121 and Paperclip stopped answering.
# Cron (paperclip): */5 * * * * /usr/local/bin/test-reap
set -euo pipefail
TEST_MAX_MIN=${TEST_MAX_MIN:-50}
python3 - "$TEST_MAX_MIN" <<'PY'
import os, re, sys, time, signal, datetime
limit = float(sys.argv[1]) * 60
me, uid = os.getpid(), os.getuid()
hz = os.sysconf("SC_CLK_TCK")
uptime = float(open("/proc/uptime").read().split()[0])
runner = re.compile(r"(^|[/\s])(vitest|jest|mocha)(\.m?js)?(\s|$)|playwright(\.m?js)?\s+test\b|run-vitest")
procs = {}  # pid -> (ppid, age seconds, cmdline)
for d in os.listdir("/proc"):
    if not d.isdigit(): continue
    try:
        if os.stat(f"/proc/{d}").st_uid != uid: continue
        st = open(f"/proc/{d}/stat").read().rsplit(")", 1)[1].split()
        cmd = open(f"/proc/{d}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace").strip()
        procs[int(d)] = (int(st[1]), uptime - int(st[19]) / hz, cmd)
    except Exception:
        pass
kids = {}
for p, (pp, _, _) in procs.items(): kids.setdefault(pp, []).append(p)
roots = {p for p, (_, age, cmd) in procs.items() if p != me and age > limit and runner.search(cmd)}
# only the topmost matching process of each chain; its tree goes with it
roots = {p for p in roots if procs[p][0] not in roots}
doomed = set()
for r in roots:
    todo = [r]
    while todo:
        p = todo.pop()
        if p in doomed or p == me: continue
        doomed.add(p); todo += kids.get(p, [])
for r in sorted(roots):
    print(f"{datetime.datetime.now(datetime.timezone.utc):%FT%TZ} killing {r} ({procs[r][1]/60:.0f} min): {procs[r][2][:160]}", flush=True)
for sig in (signal.SIGTERM, signal.SIGKILL):
    for p in doomed:
        try: os.kill(p, sig)
        except ProcessLookupError: pass
    if sig == signal.SIGTERM and doomed: time.sleep(10)
PY
