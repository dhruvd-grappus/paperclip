#!/bin/bash
set -e
export HOME=/home/paperclip
TOK=$(jq -r '.credentials["https://187.126.114.172.sslip.io"].token' ~/.paperclip/auth.json)
C=d255c3a4-2066-4d81-8c40-862ad8208963; AG=221ca6db-6cf1-49ff-bdf1-270a53c201f9; PID=c42fab6a-e603-4162-994e-82e21ad99950
B=$(~/pc GET /issues/GRA-166 | jq -r .id)
NEW=()
for n in 167 168; do
  J=$(~/pc GET /issues/GRA-$n); ID=$(echo "$J" | jq -r .id); T=$(echo "$J" | jq -r .title); D=$(echo "$J" | jq -r .description)
  echo '{"status":"cancelled"}' > /tmp/c.json
  curl -s -X PATCH -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" --data-binary @/tmp/c.json https://187.126.114.172.sslip.io/api/issues/$ID | jq -r '"cancelled "+.identifier'
  jq -n --arg t "$T" --arg d "$D" --arg p "$PID" --arg a "$AG" --arg k "recreate:$n:$(date +%s)" '{title:$t,description:$d,status:"todo",priority:"medium",projectId:$p,assigneeAgentId:$a,idempotencyKey:$k}' > /tmp/n.json
  R=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" --data-binary @/tmp/n.json https://187.126.114.172.sslip.io/api/companies/$C/issues)
  echo "$R" | jq -r '"created "+.identifier+" "+.id'; NEW+=("$(echo "$R" | jq -r .id)")
done
jq -n --arg a "${NEW[0]}" --arg b "${NEW[1]}" '{status:"blocked",blockedByIssueIds:[$a,$b]}' > /tmp/blk.json
curl -s -X PATCH -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" --data-binary @/tmp/blk.json https://187.126.114.172.sslip.io/api/issues/$B | jq -c '{identifier,status,blockedBy:(.blockedByIssueIds|length)}'
