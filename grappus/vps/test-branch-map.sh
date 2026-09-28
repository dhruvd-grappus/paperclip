#!/bin/bash
# Tests for vps/branch-map. Builds throwaway git remotes + clones under a temp dir; no network, no Paperclip.
# Usage: bash test-branch-map.sh [path/to/branch-map]   (default: branch-map next to this file). Exit 0 = all pass.
set -uo pipefail
BM=${1:-$(dirname "$0")/branch-map}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t GIT_CONFIG_GLOBAL=/dev/null
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL $1"; echo "$OUT" | sed 's/^/     | /'; }
has()  { echo "$OUT" | grep -qE -- "$2" && ok "$1" || bad "$1 (want /$2/)"; }
hasnt(){ echo "$OUT" | grep -qE -- "$2" && bad "$1 (unwanted /$2/)" || ok "$1"; }
old()  { GIT_AUTHOR_DATE="2024-01-01T00:00:00" GIT_COMMITTER_DATE="2024-01-01T00:00:00" "$@"; }
c()    { echo "$2" >> "$1/f-$2"; git -C "$1" add -A && git -C "$1" commit -qm "$2"; }

# repo A: main (prod), develop (base), ai-dev, stale uat, hotfix/*, release/*, feature, cherry-picked release
W=$T/work; git init -q -b main "$W"; c "$W" base
old git -C "$W" checkout -qb uat; old c "$W" uatold
git -C "$W" checkout -q main; git -C "$W" checkout -qb develop
c "$W" d1; c "$W" d2; c "$W" d3
git -C "$W" checkout -q main
git -C "$W" cherry-pick "$(git -C "$W" rev-parse develop~2)" >/dev/null   # d1 released by cherry-pick: must not count as unreleased
c "$W" hot1                                                         # prod-only hotfix
git -C "$W" checkout -qb hotfix/x; c "$W" hx
git -C "$W" checkout -q main; git -C "$W" checkout -qb release/prod/01; c "$W" rel
git -C "$W" checkout -q develop; git -C "$W" checkout -qb ai-dev; c "$W" ai1
git -C "$W" checkout -q develop; git -C "$W" checkout -qb feature/foo; c "$W" ff
git -C "$W" checkout -q develop; git -C "$W" checkout -qb customer-base; c "$W" cb
git -C "$W" checkout -q main; git -C "$W" merge -q --no-ff -m "merge hotfix" hotfix/x  # merge commit on prod
git clone -q --bare "$W" "$T/originA.git"
git clone -q "$T/originA.git" "$T/A"

# repo B: master + dev only, remote default = dev
git init -q -b master "$T/wb"; c "$T/wb" b0; git -C "$T/wb" checkout -qb dev; c "$T/wb" b1
git clone -q --bare "$T/wb" "$T/originB.git"; git -C "$T/originB.git" symbolic-ref HEAD refs/heads/dev
git clone -q "$T/originB.git" "$T/B"

# repo C: only feature branches
git init -q -b feat "$T/wc"; c "$T/wc" c0; git clone -q --bare "$T/wc" "$T/originC.git"; git clone -q "$T/originC.git" "$T/C"

echo "--- 1. --primary, tiers and filtering"
OUT=$("$BM" --primary "$T/A" 2>&1); RC=$?
[ $RC -eq 0 ] && ok "exit 0" || bad "exit $RC"
has   "prod main listed"            '^   prod +main '
has   "lower develop listed"        '^   lower +develop '
has   "lower ai-dev listed"         '^   lower +ai-dev '
has   "staging uat listed as STALE" '^   staging +uat .*STALE'
hasnt "hotfix skipped"              'hotfix/x'
hasnt "release skipped"             'release/prod'
hasnt "feature skipped"             'feature/foo'
hasnt "unknown branch skipped without repoRef" 'customer-base'
hasnt "stale branch has no drift"   'uat .*vs main'
hasnt "prod branch has no drift"    'prod +main .*vs '
echo "$OUT" | awk '/^   prod/{p=NR} /^   staging/{s=NR} /^   lower/{l=NR} END{exit !(p<s && s<l)}' && ok "order prod < staging < lower" || bad "order"

echo "--- 2. drift by patch, merges excluded"
has "develop: d2,d3 unreleased (d1 cherry-picked), hot1+hx prod-only" 'develop .*vs main: \+2 unreleased, -2 prod-only'
has "ai-dev: d2,d3,ai1 unreleased"  'ai-dev .*vs main: \+3 unreleased, -2 prod-only'

echo "--- 3. fresh fetch: new remote commit shows up"
git -C "$W" checkout -q develop; c "$W" d4; git -C "$W" push -q "$T/originA.git" develop
OUT=$("$BM" --primary "$T/A" 2>&1)
has "develop head is d4 after fetch" 'develop +[0-9a-f]+ d4'
has "drift updated to +3"           'develop .*vs main: \+3 unreleased'
git -C "$W" push -q "$T/originA.git" :feature/foo
OUT=$("$BM" --primary "$T/A" 2>&1)
[ -z "$(git -C "$T/A" branch -r --list origin/feature/foo)" ] && ok "prune removed deleted remote branch" || bad "prune"

echo "--- 4. default branch + several clones in one call"
OUT=$("$BM" --primary "$T/A" --primary "$T/B" --primary "$T/C" 2>&1)
has "B dev marked default"          'lower +dev .*\[default\]'
has "B drift vs master"             'dev .*vs master: \+1 unreleased, -0 prod-only'
has "C reports none"                'no environment branches found \(default: feat\)'
[ "$(echo "$OUT" | grep -c '^== ')" -eq 3 ] && ok "three blocks" || bad "three blocks"

echo "--- 5. fetch failure keeps last state, missing clone"
git -C "$T/B" remote set-url origin "$T/nowhere.git"
OUT=$("$BM" --primary "$T/B" --primary "$T/missing" 2>&1); RC=$?
has "fetch failure reported"        'fetch FAILED'
has "still shows last fetched dev"  'lower +dev '
has "missing clone reported"        'primary clone missing'
[ $RC -eq 0 ] && ok "exit 0 despite failures" || bad "exit $RC"

echo "--- 6. --project via stub pc: repoRef, localPath fallback, --workspace filter"
mkdir -p "$T/root/P1"; cp -r "$T/A" "$T/root/P1/wsA"
cat > "$T/pc" <<EOF
#!/bin/bash
case "\$2" in
  /projects/P1) echo '{"workspaces":[{"name":"wsA","localPath":null,"repoRef":"refs/heads/customer-base"},{"name":"wsB","localPath":"$T/C","repoRef":null}]}';;
  *) echo '{"error":"not found"}';;
esac
EOF
chmod +x "$T/pc"
OUT=$(BRANCH_MAP_PC="$T/pc" BRANCH_MAP_ROOT="$T/root" "$BM" --project P1 2>&1)
has "repoRef branch shown as lower + build base" 'lower +customer-base .*\[build base\]'
has "path falls back to root/<project>/<name>"   "== wsA  \($T/root/P1/wsA\)"
has "second workspace via localPath"             "== wsB  \($T/C\)"
sed -i 's#refs/heads/customer-base#main#' "$T/pc"
OUT=$(BRANCH_MAP_PC="$T/pc" BRANCH_MAP_ROOT="$T/root" "$BM" --project P1 2>&1)
has "repoRef main keeps prod tier"  'prod +main .*\[build base\]'
OUT=$(BRANCH_MAP_PC="$T/pc" BRANCH_MAP_ROOT="$T/root" "$BM" --project P1 --workspace wsB 2>&1)
hasnt "--workspace filters others"  '== wsA'
OUT=$(BRANCH_MAP_PC="$T/pc" BRANCH_MAP_ROOT="$T/root" "$BM" --project P1 --workspace nope 2>&1); RC=$?
[ $RC -ne 0 ] && ok "unknown workspace exits non-zero" || bad "unknown workspace rc $RC"
OUT=$(BRANCH_MAP_PC="$T/pc" "$BM" --project NOPE 2>&1); RC=$?
[ $RC -ne 0 ] && has "unknown project reported" 'not found' || bad "unknown project rc $RC"
OUT=$("$BM" 2>&1); RC=$?
[ $RC -eq 2 ] && ok "no args exits 2" || bad "no args rc $RC"

echo "--- 7. read-only: no local branch or worktree created"
[ "$(git -C "$T/A" branch --format='%(refname:short)')" = "main" ] && ok "clone A still only has local main" || bad "local branches changed"

echo; echo "pass $PASS  fail $FAIL"; [ $FAIL -eq 0 ]
