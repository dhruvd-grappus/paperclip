#!/usr/bin/env bash
# Stop previews idle > 1h, whose worktree or process is gone, or beyond the newest MAX_PREVIEWS.
# Why: 2026-09-25 OOM kill of Paperclip — ten next-server previews at 1-1.7 GB each on a 15 GB box.
# Cron (paperclip): */10 * * * * /usr/local/bin/preview-reap
set -euo pipefail
REG=/home/paperclip/preview-registry.json
MAX_PREVIEWS=${MAX_PREVIEWS:-3}
IDLE_HOURS=${IDLE_HOURS:-1}
[ -f "$REG" ] || exit 0
python3 - "$REG" "$MAX_PREVIEWS" "$IDLE_HOURS" <<'PY' | while read -r slug cwd why; do
import json,sys,datetime,os
r=json.load(open(sys.argv[1])); cap=int(sys.argv[2]); idle=float(sys.argv[3])
now=datetime.datetime.now(datetime.timezone.utc)
def ts(e):
    last=e.get("lastHit") or e.get("startedAt")
    return datetime.datetime.fromisoformat(last.replace("Z","+00:00")) if last else now-datetime.timedelta(days=9)
def alive(pid):
    try:
        if int(pid)<=0: return False
        os.kill(int(pid),0); return True
    except Exception: return False
victims=[]
for slug,e in r.items():
    age=(now-ts(e)).total_seconds()/3600
    if not os.path.isdir(e.get("cwd","")): victims.append((slug,e,"worktree-gone"))
    elif not alive(e.get("pid",0)): victims.append((slug,e,"process-dead"))
    elif age>idle: victims.append((slug,e,"idle-%.1fh"%age))
keep=[(s,e) for s,e in r.items() if s not in {v[0] for v in victims}]
keep.sort(key=lambda x: ts(x[1]), reverse=True)
for s,e in keep[cap:]: victims.append((s,e,"over-cap"))
for slug,e,why in victims: print(slug, e.get("cwd","/nonexistent"), why)
PY
  ( cd "$cwd" 2>/dev/null && preview-url stop >/dev/null 2>&1 ) || true
  python3 - "$REG" "$slug" <<'PY'
import json,sys
p,slug=sys.argv[1],sys.argv[2]; r=json.load(open(p)); r.pop(slug,None); json.dump(r,open(p,'w'),indent=2)
PY
  echo "$(date -u +%FT%TZ) reaped $slug ($why)"
done
