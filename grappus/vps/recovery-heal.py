#!/usr/bin/env python3
"""Auto-recover issues Paperclip gave up on for infrastructure reasons. Cron every 2 min as user paperclip
(→ /home/paperclip/agents/recovery-heal.py, log ~/recovery-heal.log, state ~/.recovery-heal.json).

When a native run dies, Paperclip opens a recovery action and, once automatic recovery stops, hands it to the
board (ownerType "board"): the issue sits blocked and every later wake is skipped until someone resolves it.
It never retries a provider-side failure on its own because it cannot prove what the dead run's shell commands
changed. For the failures below the cause is ours, not the work, so a resume is safe:

  identity  runner_state_identity_mismatch        session-state read bug (dev-pipe gotcha 33); fails at startup
  auth      ACP agent reported a terminal access failure    expired/revoked Claude token (gotcha 34);
   service   ACP agent reported a terminal service failure   Anthropic-side outage
             → only once the current Claude token has >= 30 min left
   limit     ACP agent reported a terminal limit failure     subscription rate limit → only 60 min after the failure
   timeout   recovery cause native_session_retry_exhausted   the 25-minute run cap expired mid-work and the
             resume did not survive (GRA-262: timeout collided with a server restart)

For each, in this order, so the issue gets exactly ONE new run:
  1. post the instruction comment while the recovery action is still open: Paperclip skips wakes then
     ("execution_reconciliation_required"), so the comment is only stored for the next run to read;
  2. resolve the action (outcome "restored", issue back to todo; reconciliation actionOutcome "not_performed"
     when the dead run made no tool calls, else "mixed"); Paperclip queues its own recovery wake;
  3. if no run has picked the issue up 4 min later (that wake does not always come), post a short nudge comment,
     which wakes the agent.
Resolving AND commenting afterwards gave two runs (the comment's, plus the delayed recovery wake once the first
ended); the second collided with the first's same-run resume (GRA-231, 2026-09-27: QA ran three times).
Build issues are told to inspect their worktree first; Review/QA/Memory resume from their saved state.

Never touches: Slack-origin issues (Paperclip forbids reviving a failed chat run: cancel and resend), actions the
agent still owns, unknown failure classes (logged once), a run already recovered, or an issue recovered twice in
the last 24 h (then a human decides). --dry-run prints decisions without acting. Idempotent."""
import datetime, json, os, re, sys, time, urllib.parse, urllib.request

B = "http://127.0.0.1:3100/api"  # direct calls need /api (~/pc adds it for you)
C ="d255c3a4-2066-4d81-8c40-862ad8208963"
AGENT = "221ca6db-6cf1-49ff-bdf1-270a53c201f9"  # Clarifier
K = json.load(open(os.path.expanduser("~/.paperclip/auth.json")))["credentials"]["https://187.126.114.172.sslip.io"]["token"]
STATE = os.path.expanduser("~/.recovery-heal.json")
CRED = os.path.expanduser("~/.claude/.credentials.json")
MAX_PER_DAY = 2
LIMIT_COOLDOWN_S = 3600
MIN_TOKEN_LEFT_S = 30 * 60
NUDGE_AFTER_S = 240
DRY = "--dry-run" in sys.argv

CLASSES = [
    ("identity", re.compile(r"runner_state_identity_mismatch")),
    ("auth", re.compile(r"ACP agent reported a terminal access failure")),
    ("service", re.compile(r"ACP agent reported a terminal service failure")),
    ("limit", re.compile(r"ACP agent reported a terminal limit failure")),
]
TIMEOUT_CAUSE = "native_session_retry_exhausted"
WHY = {
    "identity": "a Paperclip session-state bug at startup (fork build 12 fixes the cause)",
    "auth": "an expired Claude login token",
    "service": "a temporary Anthropic outage",
    "limit": "the Claude subscription rate limit",
    "timeout": "the 25-minute run cap expiring mid-work (the automatic resume did not survive)",
}


def log(msg):
    print(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} {msg}", flush=True)


def req(m, p, body=None):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))


def iso(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() if ts else 0.0


def token_seconds_left():
    if os.path.exists(os.path.expanduser("~/.claude/setup-token")):
        return 10**9  # long-lived token, never expires mid-run
    try:
        return json.load(open(CRED))["claudeAiOauth"]["expiresAt"] / 1000 - time.time()
    except Exception:
        return 0


def tool_calls(run_id):
    try:
        events = req("GET", f"/heartbeat-runs/{run_id}/events?limit=10000")
    except Exception:
        return None
    return sum(1 for e in events if str(e.get("eventType", "")).startswith("tool.execution.completed"))


def wake_text(issue, klass, did_work):
    title = issue.get("title") or ""
    why = WHY[klass]
    if title.startswith("QA:"):
        what = "Resume: reuse this issue's spec files, screenshots and saved sign-in in the QA sandbox; re-run only criteria not yet verified."
    elif title.startswith(("Review:", "Memory:")):
        what = "Re-run it from the start; it is read-only."
    elif title.startswith("Build:"):
        what = ("Resume: first check `git status` and `git log` in this task's worktree under /home/paperclip/worktrees "
                "and continue from what is already there; do not start over." if did_work else
                "Resume the build normally; nothing was done in the failed run.")
    else:
        what = "Resume: re-read the current state of this task and its children before acting; do not redo finished steps."
    return f"Auto-recovery: the previous run stopped because of {why}, not because of the work. {what}"


def notify_parent(issue, ident, klass):
    """Tell the parent task a child was auto-recovered, so scope hears about it.

    A board comment on the still-open parent restarts it (status → todo, blockers cleared);
    the scope skill's timed-out-child branch then posts the requester notice and re-blocks.
    Skipped when the parent is already finished (never reopen an accepted task)."""
    parent_id = issue.get("parentId")
    if not parent_id:
        return
    try:
        parent = req("GET", f"/issues/{parent_id}")
    except Exception as e:
        log(f"{ident}: parent unreadable ({e})")
        return
    if (parent.get("status") or "") in ("done", "cancelled"):
        log(f"{ident}: parent {parent.get('identifier') or parent_id} already finished; no notice")
        return
    body = (f"Auto-recovery: {ident} stopped ({WHY[klass]}) and was resumed. "
            f"Still waiting on it; no action needed.")
    try:
        req("POST", f"/issues/{parent_id}/comments", {"body": body})
        log(f"{ident}: parent {parent.get('identifier') or parent_id} notified")
    except Exception as e:
        log(f"{ident}: parent notice failed ({e})")


def nudge_pending(state, now):
    """Wake resolved issues that no run picked up (Paperclip's recovery wake does not always fire)."""
    for issue_id, at in list(state.setdefault("pending", {}).items()):
        try:
            it = req("GET", f"/issues/{issue_id}")
        except Exception:
            continue
        started = it.get("status") != "todo" or it.get("executionRunId") or it.get("checkoutRunId")
        if started:
            del state["pending"][issue_id]
        elif now - at >= NUDGE_AFTER_S:
            ident = it.get("identifier") or issue_id
            log(f"{ident}: no run {int(now - at)}s after resolve; nudging{' [dry-run]' if DRY else ''}")
            if not DRY:
                try:
                    req("POST", f"/issues/{issue_id}/comments", {"body": "Auto-recovery: resume now (see the comment above)."})
                except Exception as e:
                    log(f"{ident}: nudge failed ({e})")
                    continue
            del state["pending"][issue_id]


def main():
    state = json.load(open(STATE)) if os.path.exists(STATE) else {"runs": [], "issues": {}}
    state.setdefault("pending", {})
    now = time.time()
    nudge_pending(state, now)
    issues = req("GET", f"/companies/{C}/issues?" + urllib.parse.urlencode(
        {"status": "blocked", "assigneeAgentId": AGENT, "limit": 500}))
    for it in issues:
        if it.get("assigneeAgentId") != AGENT or it.get("status") != "blocked":
            continue
        ident = it.get("identifier") or it["id"]
        try:
            active = (req("GET", f"/issues/{it['id']}/recovery-actions") or {}).get("active")
        except Exception as e:
            log(f"{ident}: recovery-actions unreadable ({e})")
            continue
        if not active or active.get("status") != "active" or active.get("ownerType") != "board":
            continue  # nothing to resolve, or Paperclip's own retries still own it
        run_id = (active.get("evidence") or {}).get("runId")
        if not run_id or run_id in state["runs"]:
            continue
        if it.get("originKind") == "chat_channel":
            log(f"{ident}: Slack-origin, cannot be revived (cancel and resend from Slack); skipped")
            state["runs"].append(run_id)
            continue
        try:
            run = req("GET", f"/heartbeat-runs/{run_id}")
        except Exception as e:
            log(f"{ident}: run {run_id} unreadable ({e})")
            continue
        err = run.get("error") or ""
        klass = next((name for name, rx in CLASSES if rx.search(err)), None)
        if klass is None and active.get("cause") == TIMEOUT_CAUSE:
            klass = "timeout"  # retry-exhausted: the run's own error text names the last resume failure, not the cap
        if klass is None:
            log(f"{ident}: not auto-recoverable ({active.get('cause')}: {err[:120]}); left for a human")
            state["runs"].append(run_id)
            continue
        if klass in ("auth", "service") and token_seconds_left() < MIN_TOKEN_LEFT_S:
            log(f"{ident}: {klass} failure, but the Claude token has < 30 min left; waiting for native-token.sh")
            continue
        if klass == "limit" and now - iso(run.get("finishedAt")) < LIMIT_COOLDOWN_S:
            continue  # rate limit: give the window time to reset
        recent = [t for t in state["issues"].get(it["id"], []) if now - t < 86400]
        if len(recent) >= MAX_PER_DAY:
            log(f"{ident}: already auto-recovered {len(recent)}x in 24 h; left for a human")
            state["runs"].append(run_id)
            continue
        calls = 0 if klass == "identity" else tool_calls(run_id)
        did_work = calls is None or calls > 0
        outcome = "mixed" if did_work else "not_performed"
        body = {
            "actionId": active["id"], "outcome": "restored", "sourceIssueStatus": "todo",
            "executionReconciliation": {
                "runId": run_id, "providerStopped": True, "actionOutcome": outcome,
                "outcomeEvidence": f"recovery-heal: run failed with '{err[:200]}' ({klass}); {calls if calls is not None else 'unknown'} tool calls recorded before it stopped.",
            },
            "resolutionNote": f"Auto-recovered by recovery-heal ({klass}).",
        }
        log(f"{ident}: {klass} → resolve ({outcome}) and wake{' [dry-run]' if DRY else ''}")
        if DRY:
            continue
        try:
            # Comment first: the open recovery action makes Paperclip skip this comment's wake.
            req("POST", f"/issues/{it['id']}/comments", {"body": wake_text(it, klass, did_work)})
            req("POST", f"/issues/{it['id']}/recovery-actions/resolve", body)
        except Exception as e:
            log(f"{ident}: comment/resolve failed ({e})")
            continue
        notify_parent(it, ident, klass)
        state["runs"].append(run_id)
        state["issues"][it["id"]] = recent + [now]
        state["pending"][it["id"]] = now
    state["runs"] = state["runs"][-500:]
    if not DRY:
        tmp = STATE + ".tmp"
        json.dump(state, open(tmp, "w"))
        os.replace(tmp, STATE)


if __name__ == "__main__":
    main()
