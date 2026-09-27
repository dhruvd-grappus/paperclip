#!/usr/bin/env bash
# Recreate the Autonomous AI Coder company on the hosted instance.
# Needs a board API key from the hosted UI (Settings → API keys) in PAPERCLIP_API_KEY.
set -euo pipefail
B="${PAPERCLIP_API_URL:-https://187.126.114.172.sslip.io}"
: "${PAPERCLIP_API_KEY:?set PAPERCLIP_API_KEY (board API key from hosted UI)}"
H=(-H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json')
WS=/home/paperclip/workspace
cd "$(dirname "$0")"

C=$(curl -sS "${H[@]}" -X POST "$B/api/companies" -d '{"name":"Autonomous AI Coder","description":"An autonomous coder in the cloud, run from Slack. Agents clarify, plan, build on the VPS, check their own work, and hand back a link. A human approves the plan and the result.","budgetMonthlyCents":50000}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"])')
echo "company $C"
curl -sS "${H[@]}" -X PATCH "$B/api/companies/$C" -d '{"interactionResolverGovernance":{"request_confirmation":{"defaultPolicy":"human_only"}}}' >/dev/null

hire() { python3 - "$C" "$WS" "$@" <<'PY'
import json,sys,os,urllib.request
C,WS,name,role,title,icon,f,reports,caps=sys.argv[1:10]
body={"name":name,"role":role,"title":title,"icon":icon,"capabilities":caps,"adapterType":"claude_local",
 "adapterConfig":{"cwd":WS,"maxTurnsPerRun":200},
 "instructionsBundle":{"entryFile":"AGENTS.md","files":{"AGENTS.md":open(f).read().replace("/Users/dhruv/Desktop/dev-pipe/vault","/home/paperclip/vault")}},
 "runtimeConfig":{"heartbeat":{"enabled":False,"wakeOnDemand":True}},"budgetMonthlyCents":10000}
if reports!="-": body["reportsTo"]=reports
r=urllib.request.Request(os.environ.get("PAPERCLIP_API_URL","https://187.126.114.172.sslip.io")+f"/api/companies/{C}/agent-hires",data=json.dumps(body).encode(),headers={"Content-Type":"application/json","Authorization":"Bearer "+os.environ["PAPERCLIP_API_KEY"]})
d=json.load(urllib.request.urlopen(r)); a=d.get("agent",d); print(a["id"])
PY
}
P=$(hire Planner ceo "Delivery Lead / Planner" target agents/planner.md - "Turns a Scope into an approvable plan, runs both human gates, creates child issues and Linear tickets, closes tasks and updates the vault.")
CL=$(hire Clarifier researcher "Scope Clarifier" search agents/clarifier.md "$P" "First contact for every Slack task: reads the vault, asks the user what is unclear, produces the Scope.")
hire Executor engineer "Software Engineer" code agents/executor.md "$P" "Implements approved plans inside the repo radius on the workspace, opens the PR or preview link, fixes QA and review findings." >/dev/null
hire QA qa "QA Engineer" bug agents/qa.md "$P" "Verifies output against Scope and Plan, runs integration tests, posts pass/fail findings with evidence." >/dev/null
hire CodeReviewer engineer "Code Reviewer" eye agents/code-reviewer.md "$P" "Reviews diffs for edge cases, error handling, conventions, reusability and repo radius; approves or requests changes." >/dev/null
curl -sS "${H[@]}" -X PATCH "$B/api/companies/$C" -d '{"requireBoardApprovalForNewAgents":true}' >/dev/null

I=$(curl -sS "${H[@]}" -X POST "$B/api/companies/$C/issues" -d '{"title":"Board Operations","description":"Standing issue for board decision log","status":"todo","priority":"medium"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -sS "${H[@]}" -X PUT "$B/api/issues/$I/documents/decision-log" -d "{\"title\":\"Decision Log\",\"format\":\"markdown\",\"body\":\"# Decision Log\\n\\n## $(date +%F)\\n- Company recreated on Hostinger VPS (Postgres 18, authenticated public mode).\\n- Five agents hired; two human gates via request_confirmation (human_only).\\n\"}" >/dev/null

E=$(curl -sS "${H[@]}" -X POST "$B/api/companies/$C/chat-endpoints" -d "{\"provider\":\"slack\",\"assignedAgentId\":\"$CL\",\"name\":\"Slack task intake\"}")
echo "$E" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("chat endpoint",d["id"]); print("slack webhook: https://187.126.114.172.sslip.io/api/chat-webhooks/"+d["publicId"]+"/slack"); print("slash command:",d["setup"]["command"])'
echo "Approve pending hires: $B/api/companies/$C/approvals?status=pending (none expected; approval was enabled after hiring)."
