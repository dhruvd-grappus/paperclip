#!/usr/bin/env bash
# Stop previews idle > 1h, whose worktree or process is gone, or beyond the newest MAX_PREVIEWS.
# A preview-stack (registry entries tagged "stack") is one unit: idle = its newest hit, counts once toward the
# cap, and is stopped whole with `preview-stack down` (manifest and data kept, `up` brings it back).
# Stacks idle out at STACK_IDLE_HOURS (default 6, not 1): a requester asking "give me the testing link" on a
# task they last touched hours ago should not pay a cold rebuild (api migrate+seed, admin npm run build).
# Memory budget: when all live previews together hold more than PREVIEW_MEM_MB of RSS (each registry pid's
# whole process tree plus a stack's services from ~/preview-stacks/<task>/state.json), whole units are reaped
# oldest first until under it; the newest unit always stays. A count cap alone misses a stack of five servers
# or one `next dev` at 2.5 GB.
# Why: 2026-09-25 OOM kill of Paperclip — ten next-server previews at 1-1.7 GB each on a 15 GB box; 2026-10-05
# load 121 with swap full — two stacks (7 servers, local mongod/redis) plus stray test runs.
# Cron (paperclip): */10 * * * * /usr/local/bin/preview-reap
set -euo pipefail
REG=${PREVIEW_REGISTRY:-/home/paperclip/preview-registry.json}
MAX_PREVIEWS=${MAX_PREVIEWS:-3}
IDLE_HOURS=${IDLE_HOURS:-1}
STACK_IDLE_HOURS=${STACK_IDLE_HOURS:-6}
PREVIEW_MEM_MB=${PREVIEW_MEM_MB:-4096}
STACKS=${PREVIEW_STACKS:-/home/paperclip/preview-stacks}
[ -f "$REG" ] || exit 0
python3 - "$REG" "$MAX_PREVIEWS" "$IDLE_HOURS" "$STACK_IDLE_HOURS" "$PREVIEW_MEM_MB" "$STACKS" <<'PY' | while read -r slug cwd why stack; do
import json,sys,datetime,os
r=json.load(open(sys.argv[1])); cap=int(sys.argv[2]); idle=float(sys.argv[3]); stack_idle=float(sys.argv[4])
mem_budget=float(sys.argv[5])*1024; stacks_dir=sys.argv[6]
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
units={}  # unit = stack name, or the slug itself for a lone preview
for slug,e in r.items():
    if not os.path.isdir(e.get("cwd","")): victims.append((slug,e,"worktree-gone"))
    elif not alive(e.get("pid",0)): victims.append((slug,e,"process-dead"))
    else: units.setdefault(e.get("stack") or slug,[]).append((slug,e))
def unit_ts(u): return max(ts(e) for _,e in units[u])
live=[]
for u in units:
    age=(now-unit_ts(u)).total_seconds()/3600
    limit = stack_idle if any(e.get("stack") for _,e in units[u]) else idle
    if age>limit: victims += [(s,e,"idle-%.1fh"%age) for s,e in units[u]]
    else: live.append(u)
live.sort(key=unit_ts, reverse=True)
for u in live[cap:]: victims += [(s,e,"over-cap") for s,e in units[u]]
live=live[:cap]
kids={}; rss={}  # ppid -> children, pid -> RSS in KiB, from one /proc pass
for d in os.listdir("/proc"):
    if not d.isdigit(): continue
    try:
        st=open(f"/proc/{d}/stat").read().rsplit(")",1)[1].split()
        kids.setdefault(int(st[1]),[]).append(int(d)); rss[int(d)]=int(st[21])*os.sysconf("SC_PAGE_SIZE")//1024
    except Exception: pass
def tree_kb(pid):
    todo=[int(pid or 0)]; seen=set(); kb=0
    while todo:
        p=todo.pop()
        if p<=0 or p in seen: continue
        seen.add(p); kb+=rss.get(p,0); todo+=kids.get(p,[])
    return kb
def unit_kb(u):
    kb=sum(tree_kb(e.get("pid",0)) for _,e in units[u])
    stack=next((e.get("stack") for _,e in units[u] if e.get("stack")),None)
    if stack:
        try: svcs=json.load(open(os.path.join(stacks_dir,stack,"state.json"))).get("services",{})
        except Exception: svcs={}
        kb+=sum(tree_kb(v.get("pid",0)) for v in svcs.values())
    return kb
total=sum(unit_kb(u) for u in live)
for u in reversed(live[1:]):  # oldest first; the newest unit always stays
    if total<=mem_budget: break
    kb=unit_kb(u); total-=kb
    victims += [(s,e,"over-mem-%dMB"%(kb//1024)) for s,e in units[u]]
for slug,e,why in victims: print(slug, e.get("cwd","/nonexistent"), why, e.get("stack") or "-")
PY
  if [ "$stack" != "-" ] && [[ "$why" == idle* || "$why" == over-* ]]; then
    preview-stack down "$stack" >/dev/null 2>&1 || true   # whole stack, services included
  fi
  ( cd "$cwd" 2>/dev/null && PREVIEW_SLUG="$slug" preview-url stop >/dev/null 2>&1 ) || true
  python3 - "$REG" "$slug" <<'PY'
import json,sys
p,slug=sys.argv[1],sys.argv[2]; r=json.load(open(p)); r.pop(slug,None); json.dump(r,open(p,'w'),indent=2)
PY
  echo "$(date -u +%FT%TZ) reaped $slug ($why)"
done
