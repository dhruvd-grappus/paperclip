#!/usr/bin/env python3
"""Replace the preview host in all claude_local agent instructions with the dash-form sslip host."""
import json, os, urllib.request
B = "https://187.126.114.172.sslip.io"; C = "d255c3a4-2066-4d81-8c40-862ad8208963"
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"][B]["token"]
def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m, headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))
for a in req("GET", f"/api/companies/{C}/agents"):
    if a["adapterType"] != "claude_local":
        continue
    cur = req("GET", f"/api/agents/{a['id']}/instructions-bundle/file?path=AGENTS.md&companyId={C}")["content"]
    new = cur.replace("gra-NN.187.126.114.172.sslip.io", "gra-NN.187-126-114-172.sslip.io").replace("gra-28.187.126.114.172.sslip.io", "gra-28.187-126-114-172.sslip.io").replace("<issue>.187.126.114.172.sslip.io", "<issue>.187-126-114-172.sslip.io")
    if new != cur:
        req("PUT", f"/api/agents/{a['id']}/instructions-bundle/file?companyId={C}", {"path": "AGENTS.md", "content": new}); print(a["name"], "updated")
