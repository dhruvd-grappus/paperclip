#!/usr/bin/env python3
"""Slack bridge for Paperclip company "Grappus" (26 Sep 2026). Runs every minute from cron as user paperclip.

Why: only the Slack-bound root task reaches the Slack thread, an agent run cannot write to its parent
(403 cross_issue_influence_run_context_required), and Paperclip edits earlier bot messages in place, so
Slack sends no notification for a new question.

What it does, with board rights (outside any agent run):
1. Question relay. A pending `ask_user_questions` card on a child task (any depth) of a Slack-bound root is
   copied to the root as a card (published to Slack as a form, `continuationPolicy: none`). When the requester
   answers it, the same answers are submitted on the child's own card, so the child resumes. If the child's
   card is answered or withdrawn elsewhere first, the copy is withdrawn.
2. Question notice. For every new pending card on a Slack-bound root (the agent's own cards and relayed copies),
   one new thread message is posted, so Slack notifies the thread.
4. QA screenshots. Image attachments named `qa-*` on a Slack-bound root (QA uploads one per criterion to its parent
   task) are uploaded into the Slack thread in criterion order, 10 images per message. Other attachments (e.g. the requester's own
   Slack uploads) are never echoed.
Cards opened before `--since` (first start) are ignored unless listed with `--include <interactionId>`.

  python3 bridge.py --dry-run          show what it would do
  python3 bridge.py                    act (cron)
  python3 bridge.py --include <id>     also relay one older card
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:3100"
COMPANY = "d255c3a4-2066-4d81-8c40-862ad8208963"
HOME = os.path.expanduser("~/slack-bridge")
STATE = os.path.join(HOME, "state.json")
DRY = "--dry-run" in sys.argv
INCLUDE = {sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--include" and i + 1 < len(sys.argv)}
PENDING = ("pending", "open", "awaiting_response")
EARLY_PREVIEW = False  # see section 1
NO_PUSH_URL = "no-push://push-refused-by-design-follow-push-failed-path-hand-off-to-review-and-qa-now"
TOKEN = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"]["https://187.126.114.172.sslip.io"]["token"]
ENV_FILE = os.path.join(HOME, ".env")  # SLACK_BOT_TOKEN=xoxb-... (mode 600); optional
SLACK_TOKEN = None
if os.path.exists(ENV_FILE):
    for line in open(ENV_FILE):
        if line.strip().startswith("SLACK_BOT_TOKEN="):
            SLACK_TOKEN = line.split("=", 1)[1].strip().strip('"') or None
now = lambda: dt.datetime.now(dt.timezone.utc)
P = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def log(*a):
    line = now().strftime("%Y-%m-%dT%H:%M:%SZ") + " " + " ".join(str(x) for x in a)
    print(line, flush=True)
    if not DRY:
        with open(os.path.join(HOME, "bridge.log"), "a") as f:
            f.write(line + "\n")


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            out = resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read().decode()[:400]}")
    return json.loads(out) if out else None


def items(x):
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        for k in ("items", "issues", "data", "conversations"):
            if isinstance(x.get(k), list):
                return x[k]
    return []


def clip(s, n):
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def slack_questions(child_payload):
    """Copy a child's questions into a card that follows the Slack form rules (see pc-lite)."""
    out, text_for = [], {}
    for q in (child_payload.get("questions") or [])[:4]:
        opts = q.get("options") or []
        free = [o for o in opts if o.get("freeText")]
        choice = [o for o in opts if not o.get("freeText")]
        if choice:
            mirrored = [{"id": o["id"], "label": clip(o.get("label"), 60), **({"description": clip(o["description"], 75)} if o.get("description") else {})}
                        for o in (choice + free)[:8]]
            out.append({"id": q["id"], "prompt": clip(q.get("prompt"), 150), "selectionMode": "single", "required": bool(q.get("required", True)), "options": mirrored})
            if free:
                tid = q["id"] + "__text"
                text_for[q["id"]] = (free[0]["id"], tid)
                out.append({"id": tid, "prompt": clip(f'If you picked "{free[0].get("label")}", type it here.', 150), "selectionMode": "single",
                            "required": False, "options": [{"id": "text", "label": "Your answer", "freeText": True}]})
        elif free:
            out.append({"id": q["id"], "prompt": clip(q.get("prompt"), 150), "selectionMode": "single", "required": bool(q.get("required", True)),
                        "options": [{"id": "text", "label": "Your answer", "freeText": True}]})
            text_for[q["id"]] = (free[0]["id"], q["id"])
    return out, text_for


def answers_for_child(root_card, text_for):
    """Map the root copy's answers back to the child's question and option ids."""
    resp = root_card.get("result") or root_card.get("response") or {}
    got = {a.get("questionId"): a for a in (resp.get("answers") or [])}
    out = []
    for qid, a in got.items():
        if qid.endswith("__text"):
            continue
        picked = a.get("optionIds") or a.get("selectedOptionIds") or []
        entry = {"questionId": qid, "optionIds": picked}
        if qid in text_for:
            free_id, tid = text_for[qid]
            t = got.get(tid, {})
            text = t.get("otherText") or t.get("text") or t.get("answer") or a.get("otherText")
            if picked == ["text"]:  # free-text-only question
                entry["optionIds"] = [free_id]
            if text:
                entry["otherText"] = text
        out.append(entry)
    return out


def slack_post(conv, text):
    """Post a new thread reply straight through Slack's API. Not a Paperclip comment, so it never expires a card."""
    parts = (conv.get("externalThreadId") or "").split(":")  # slack:<channel>:<thread ts>
    if len(parts) != 3 or not parts[2]:
        raise RuntimeError(f"no Slack thread for conversation {conv.get('id')}")
    if DRY:
        log("DRY slack post", parts[1], parts[2], "|", text)
        return
    r = urllib.request.Request("https://slack.com/api/chat.postMessage", method="POST",
                               data=json.dumps({"channel": parts[1], "thread_ts": parts[2], "text": text}).encode(),
                               headers={"Authorization": "Bearer " + SLACK_TOKEN, "Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(r, timeout=30) as resp:
        out = json.loads(resp.read())
    if not out.get("ok"):
        raise RuntimeError(f"slack chat.postMessage failed: {out.get('error')}")
    log("slack notice posted", parts[1], parts[2])


def notify(root, conv, text, key):
    if SLACK_TOKEN and conv:
        slack_post(conv, text)
    else:
        board_send(root, text, key)


def board_send(root, text, key):
    b = root.get("externalChannelBinding") or {}
    if DRY:
        log("DRY board send", root["identifier"], "|", text)
        return
    req("POST", f"/api/chat-endpoints/{b['endpointId']}/conversations/{b['conversationId']}/publications", {"body": text, "idempotencyKey": key})
    log("notice posted", root["identifier"], key)


def slack_api(method, fields):
    r = urllib.request.Request("https://slack.com/api/" + method, method="POST", data=json.dumps(fields).encode(),
                               headers={"Authorization": "Bearer " + SLACK_TOKEN, "Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(r, timeout=60) as resp:
        out = json.loads(resp.read())
    if not out.get("ok"):
        raise RuntimeError(f"slack {method} failed: {out.get('error')}")
    return out


def slack_upload_images(conv, files, comment):
    """files: [(filename, bytes)] -> one thread message with all images (files.getUploadURLExternal flow, files:write)."""
    parts = (conv.get("externalThreadId") or "").split(":")  # slack:<channel>:<thread ts>
    if len(parts) != 3 or not parts[2]:
        raise RuntimeError(f"no Slack thread for conversation {conv.get('id')}")
    ids = []
    for name, data in files:
        q = urllib.parse.urlencode({"filename": name, "length": len(data)}).encode()
        r = urllib.request.Request("https://slack.com/api/files.getUploadURLExternal", data=q, method="POST",
                                   headers={"Authorization": "Bearer " + SLACK_TOKEN})
        with urllib.request.urlopen(r, timeout=30) as resp:
            up = json.loads(resp.read())
        if not up.get("ok"):
            raise RuntimeError(f"slack files.getUploadURLExternal failed: {up.get('error')}")
        with urllib.request.urlopen(urllib.request.Request(up["upload_url"], data=data, method="POST"), timeout=60):
            pass
        ids.append({"id": up["file_id"], "title": name.rsplit(".", 1)[0]})
    slack_api("files.completeUploadExternal", {"files": ids, "channel_id": parts[1], "thread_ts": parts[2], "initial_comment": comment})


def attachment_bytes(content_path):
    r = urllib.request.Request(BASE + content_path, headers={"Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(r, timeout=60) as resp:
        return resp.read()


def unpublished_comment_ids(comment_ids):
    """Read-only DB check: which of these comments have no Slack publication at all."""
    if not comment_ids:
        return set()
    conn = json.load(open(os.path.expanduser("~/.paperclip/instances/default/config.json")))["database"]["connectionString"]
    ids = ",".join("'" + c + "'" for c in comment_ids if all(ch in "0123456789abcdef-" for ch in c))
    out = subprocess.run(["psql", conn, "-At", "-c", f"select comment_id from chat_publications where comment_id in ({ids})"],
                         capture_output=True, text=True, timeout=30, env={**os.environ, "PGOPTIONS": "-c default_transaction_read_only=on"})
    if out.returncode != 0:
        raise RuntimeError("publication check failed: " + out.stderr[:200])
    return set(comment_ids) - {line.strip() for line in out.stdout.splitlines() if line.strip()}


def tree(root_id):
    out, queue = [], [root_id]
    while queue:
        q = queue.pop()
        for i in items(req("GET", f"/api/companies/{COMPANY}/issues?parentId={q}&limit=200")):
            if i.get("parentId") == q:
                out.append(i)
                queue.append(i["id"])
    return out


state = json.load(open(STATE)) if os.path.exists(STATE) else {}
state.setdefault("since", now().isoformat())
state.setdefault("mirrors", {})   # child interaction id -> {root, rootCard, child, textFor}
state.setdefault("notified", [])
state.setdefault("republished", [])
state.setdefault("noPushRoots", [])   # root issue ids whose build worktrees must not push (review first)
state.setdefault("noPushDone", [])    # worktree paths already marked
state.setdefault("slackFiles", [])    # attachment ids already uploaded to Slack
def post_screenshots(root, root_id, conv):
    # 4. QA screenshots -> Slack thread (29 Sep: requesters see what was tested, not only the verdict)
    shots = [a for a in items(req("GET", f"/api/issues/{root_id}/attachments") or [])
             if (a.get("originalFilename") or "").startswith("qa-") and (a.get("contentType") or "").startswith("image/")
             and a["id"] not in state["slackFiles"] and P(a["createdAt"]) >= since
             and now() - P(a["createdAt"]) > dt.timedelta(minutes=1)]   # let a QA run finish uploading its set
    if not (shots and SLACK_TOKEN and conv):
        return
    # natural order: ac2 before ac10, step 2 before step 10
    key = lambda a: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", a["originalFilename"])]
    shots = sorted(shots, key=key)
    if DRY:
        log("DRY slack screenshots", root["identifier"], [a["originalFilename"] for a in shots])
        return
    for i in range(0, len(shots), 10):   # Slack takes at most 10 files per message
        batch = shots[i:i + 10]
        try:
            slack_upload_images(conv, [(a["originalFilename"], attachment_bytes(a["contentPath"])) for a in batch],
                                "Screenshots from testing:" if i == 0 else f"Screenshots from testing (continued, {i + 1}-{i + len(batch)}):")
            state["slackFiles"].extend(a["id"] for a in batch)
            log("slack screenshots posted", root["identifier"], len(batch))
        except Exception as e:  # never let an upload failure stop the other steps; the rest retry next minute
            log("slack screenshots failed", root["identifier"], e)
            return


def republish_unpublished(root, root_id, floor=dt.timedelta(minutes=2)):
    # 3a. agent replies that Paperclip never published (26 Sep, GRA-115: after a Slack form answer the first run fails
    #     reviewed_chat_execution_binding_not_authorized, and the recovery run's reply is kept off Slack)
    cs = req("GET", f"/api/issues/{root_id}/comments")
    cs = cs if isinstance(cs, list) else items(cs)
    candidates = [c["id"] for c in cs if c.get("authorAgentId") and c["id"] not in state["republished"]
                  and P(c["createdAt"]) >= since and floor < now() - P(c["createdAt"]) < dt.timedelta(minutes=30)]
    for cid in unpublished_comment_ids(candidates):
        b = root.get("externalChannelBinding") or {}
        if DRY:
            log("DRY republish reply", root["identifier"], cid)
            continue
        req("POST", f"/api/chat-endpoints/{b['endpointId']}/conversations/{b['conversationId']}/publications", {"commentId": cid})
        state["republished"].append(cid)
        log("republished undelivered reply", root["identifier"], cid)
    for cid in candidates:  # published normally: remember so it is not checked again
        if cid not in state["republished"] and not DRY:
            state["republished"].append(cid)


since = P(state["since"])
os.makedirs(HOME, exist_ok=True)

roots = {}
for e in items(req("GET", f"/api/companies/{COMPANY}/chat-endpoints")):
    for c in items(req("GET", f"/api/chat-endpoints/{e['id']}/conversations")):
        last = c.get("lastActivityAt") or c.get("updatedAt")
        if c.get("issueId") and c.get("state", "active") == "active" and last and now() - P(last) < dt.timedelta(days=3):
            roots[c["issueId"]] = c

for root_id, conv in roots.items():
    root = req("GET", f"/api/issues/{root_id}")
    if root.get("originKind") != "chat_channel":
        continue
    if root.get("status") in ("done", "cancelled"):
        # A root can be marked done a moment before its final comment is written (28 Sep, GRA-283: done at
        # 16:33:35.496, the reply landed ~200ms later), so dropping it here loses the answer. Keep the question
        # relay off for a terminal root, but still sweep its unpublished replies for a short window, and drop the
        # 2-minute floor since a terminal root has no run left that could still publish.
        upd = root.get("updatedAt")
        if upd and now() - P(upd) < dt.timedelta(minutes=30):
            republish_unpublished(root, root_id, floor=dt.timedelta(seconds=20))
            post_screenshots(root, root_id, conv)
        continue
    root_cards = {it["id"]: it for it in items(req("GET", f"/api/issues/{root_id}/interactions"))}

    # 1. relay child questions to the root
    for child in tree(root_id):
        # early preview (26 Sep, Dhruv on GRA-117): send the handoff's preview link while review and QA still run.
        # Off since pipeline v24 (27 Sep): the parent task itself posts "built, preview, now reviewing and testing"
        # when its builds finish, so this would double-post.
        if EARLY_PREVIEW and child["title"].startswith("Build:") and child.get("status") != "cancelled":
            ccs = req("GET", f"/api/issues/{child['id']}/comments")
            ccs = ccs if isinstance(ccs, list) else items(ccs)
            for cc in sorted(ccs, key=lambda x: x.get("createdAt", ""), reverse=True):
                urls = re.findall(r"https://[a-z0-9-]+\.187-126-114-172\.sslip\.io", cc.get("body") or "")
                if not urls:
                    continue
                url, key = urls[0], f"preview:{child['id']}:{urls[0]}"
                if key not in state["notified"] and now() - P(cc["createdAt"]) < dt.timedelta(minutes=60):
                    try:
                        ok = urllib.request.urlopen(url, timeout=15).status < 500
                    except urllib.error.HTTPError as e:
                        ok = e.code < 500
                    except Exception:
                        ok = False
                    if ok:
                        what = clip(child['title'][len('Build:'):].strip(), 90)
                        # only claim review and QA when their issues exist and are done (26 Sep, GRA-125 closed without them)
                        checks = [x for x in items(req("GET", f"/api/companies/{COMPANY}/issues?limit=200"))
                                  if re.match(rf"(Review|QA): {re.escape(child['identifier'])}\b", x.get("title") or "")]
                        if checks and all(x.get("status") == "done" for x in checks):
                            tail = "This part has passed code review and QA; the final check comes here next."
                        elif checks or child.get("status") != "done":
                            tail = "Code review and QA are still running; you'll get the final check here when they finish."
                        else:
                            tail = ("This part was checked by its own automated tests only; no separate code review or QA ran on it. "
                                    "The final check comes here next.")
                        notify(root, conv, f'Preview ready to try: {url} (for "{what}"). {tail}', key)
                        if not DRY:
                            state["notified"].append(key)
                break  # only the newest comment with a preview link
        for it in items(req("GET", f"/api/issues/{child['id']}/interactions")):
            if it.get("kind") == "request_confirmation":
                # confirmations cannot be copied as Slack forms either; announce them with a link (26 Sep, GRA-114)
                if it.get("status") in PENDING and it["id"] not in state["notified"] and P(it["createdAt"]) >= since:
                    notify(root, conv, f'Paperclip is waiting for a confirmation to continue: "{clip(it.get("title"), 80)}". '
                                       f'Details and the button: https://187.126.114.172.sslip.io/GRA/issues/{child["identifier"]}', f"confirm-notice:{it['id']}")
                    if not DRY:
                        state["notified"].append(it["id"])
                continue
            if it.get("kind") != "ask_user_questions":
                continue
            m = state["mirrors"].get(it["id"])
            if it.get("status") in PENDING and not m:
                if P(it["createdAt"]) < since and it["id"] not in INCLUDE:
                    continue
                qs, text_for = slack_questions(it.get("payload") or {})
                if not qs:
                    continue
                body = {"kind": "ask_user_questions", "idempotencyKey": f"relay:{it['id']}", "continuationPolicy": "none",
                        "resolverPolicy": "human_only", "title": clip(it.get("title") or "A question about your request", 60),
                        "payload": {"version": 1, "supersedeOnUserComment": False, "questions": qs}}  # our own notice is a comment; it must not expire the copy
                if DRY:
                    log("DRY relay", child["identifier"], "->", root["identifier"], "|", body["title"], "|", json.dumps(qs)[:400])
                    continue
                card = req("POST", f"/api/issues/{root_id}/interactions", body)
                state["mirrors"][it["id"]] = {"root": root_id, "rootCard": card["id"], "child": child["id"], "childIdent": child["identifier"], "textFor": text_for}
                log("relayed", child["identifier"], it["id"], "->", root["identifier"], card["id"])
                root_cards[card["id"]] = card
            elif m and not m.get("done"):
                rc = req("GET", f"/api/issues/{m['root']}/interactions/{m['rootCard']}") if m["rootCard"] not in root_cards else root_cards[m["rootCard"]]
                if it.get("status") not in PENDING:  # answered or withdrawn on the child itself
                    if rc.get("status") in PENDING and not DRY:
                        req("POST", f"/api/issues/{m['root']}/interactions/{m['rootCard']}/withdraw", {"reason": "answered on the task"})
                    m["done"] = True
                    log("child card closed elsewhere; copy withdrawn", child["identifier"])
                elif rc.get("status") not in PENDING:
                    ans = answers_for_child(rc, m.get("textFor") or {})
                    if ans and not DRY:
                        req("POST", f"/api/issues/{child['id']}/interactions/{it['id']}/respond", {"answers": ans})
                        log("answer passed to child", child["identifier"], json.dumps(ans)[:300])
                    m["done"] = True

    # 2. one new thread message per new pending card on the root
    for cid, card in root_cards.items():
        if card.get("status") not in PENDING or cid in state["notified"]:
            continue
        relayed = any(v.get("rootCard") == cid for v in state["mirrors"].values())
        if not relayed and P(card["createdAt"]) < since:
            continue
        if (card.get("payload") or {}).get("supersedeOnUserComment") and not relayed and not SLACK_TOKEN:
            # a notice is a comment; it would expire a card that is superseded by comments (seen 26 Sep on GRA-111)
            log("notice skipped (card expires on comments)", root["identifier"], cid)
            state["notified"].append(cid)
            continue
        mirror = next((v for v in state["mirrors"].values() if v.get("rootCard") == cid), None)
        if mirror:
            # A relayed copy now publishes as a real Slack form: the board may author a card on a chat-bound issue
            # (29 Sep, GRA-295). The notice stays, so the thread is notified even if that publication is delayed.
            ident = mirror.get("childIdent") or req("GET", f"/api/issues/{mirror['child']}")["identifier"]
            text = (f'Paperclip needs an answer to continue: "{clip(card.get("title"), 80)}". '
                    f'Answer on the form in this thread, or here: https://187.126.114.172.sslip.io/GRA/issues/{ident} '
                    f'(a plain reply in this thread does not reach it).')
        else:
            text = f'Paperclip has a question for you: "{clip(card.get("title"), 80)}". Please answer on the form above.'
        notify(root, conv, text, f"question-notice:{cid}")
        if not DRY:
            state["notified"].append(cid)

    # 0. review-first tasks: mark their build worktrees no-push (per-worktree git config; other tasks unaffected)
    if root_id in state["noPushRoots"]:
        idents = [c["identifier"] for c in tree(root_id)]
        wt_root = "/home/paperclip/worktrees"
        for d in sorted(os.listdir(wt_root)) if os.path.isdir(wt_root) else []:
            path = os.path.join(wt_root, d)
            if path in state["noPushDone"] or not any(d.startswith(i + "-") for i in idents) or not os.path.exists(os.path.join(path, ".git")):
                continue
            if DRY:
                log("DRY mark no-push", path)
                continue
            subprocess.run(["git", "-C", path, "config", "extensions.worktreeConfig", "true"], check=True, capture_output=True)
            # the URL is read by the agent: "review-first" made GRA-124 stop for a human push instead of handing off (26 Sep)
            subprocess.run(["git", "-C", path, "config", "--worktree", "remote.origin.pushurl", NO_PUSH_URL], check=True, capture_output=True)
            state["noPushDone"].append(path)
            log("marked no-push", root["identifier"], path)

    republish_unpublished(root, root_id)
    post_screenshots(root, root_id, conv)

    # 3. finished children but the root never woke (26 Sep, GRA-111: a follow-up sent while children ran left
    #    unadmitted chat input, which blocks every later wake until a new message arrives in the thread)
    blockers = root.get("blockedBy") or []
    if root.get("status") == "blocked" and blockers and all(b.get("status") == "done" for b in blockers):
        runs = req("GET", f"/api/issues/{root_id}/runs") or []
        last_run = max((P(r["startedAt"]) for r in runs if r.get("startedAt")), default=None)
        done_at = max((P(req("GET", f"/api/issues/{b['id']}")["updatedAt"]) for b in blockers), default=now())
        key = f"stuck:{root_id}:{done_at.isoformat()}"
        if now() - done_at > dt.timedelta(minutes=5) and (last_run is None or last_run < done_at) and key not in state["notified"]:
            notify(root, conv, "The work on this request is finished, but Paperclip is waiting for a new message here before it can post the results. "
                               "Please reply in this thread with any message (for example \"update?\").", key)
            if not DRY:
                state["notified"].append(key)

if not DRY:
    json.dump(state, open(STATE, "w"), indent=1)
