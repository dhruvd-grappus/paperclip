#!/usr/bin/env bash
# Make ACPX Claude sessions stream *thinking text* so Paperclip can show reasoning.
#
# Why: recent models default `thinking.display` to "omitted", so Claude Code
# streams signature-only thinking blocks whose text is empty. The ACP bridge
# (@agentclientprotocol/claude-agent-acp) drops empty chunks, no
# `agent_thought_chunk` is ever emitted, and Paperclip's run transcript shows no
# reasoning at all (verified: 0 reasoning items in heartbeat_run_events while
# `claude -p ... --thinking-display summarized` returns thinking text).
#
# Fix: force `display: "summarized"` on the thinking config the bridge hands to
# the Claude Agent SDK. The SDK turns that into `--thinking-display summarized`,
# which is the only supported lever (no settings key, no adapter knob — the
# runner's ACPX meta only forwards model/allowedTools/maxTurns).
#
# Idempotent. npm install replaces this package, so re-run after every
# paperclipai upgrade; runner-shim.sh calls it at the end for that reason.
set -euo pipefail
INSTALL=$(readlink -f /home/paperclip/.paperclip/cli/current)  # the install that runs, not the newest dir
F="$INSTALL/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js"
[ -f "$F" ] || { echo "acpx-thinking-patch: $F not found" >&2; exit 1; }

if grep -q 'PAPERCLIP_FORCE_THINKING_DISPLAY' "$F"; then
  echo "acpx-thinking-patch: already applied"
  exit 0
fi

cp -n "$F" "$F.bak-paperclip" 2>/dev/null || true
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """function resolveThinkingConfig(raw, logger) {
    if (raw === undefined)
        return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        logger.error(`Ignoring MAX_THINKING_TOKENS: expected a non-negative integer, got '${raw}'.`);
        return undefined;
    }
    return parsed === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: parsed };
}"""
new = """function resolveThinkingConfig(raw, logger) {
    // PAPERCLIP_FORCE_THINKING_DISPLAY: without an explicit display mode recent
    // models stream signature-only thinking blocks (empty text), the bridge drops
    // them, and no reasoning ever reaches the client.
    const display = "summarized";
    if (raw === undefined)
        return { type: "adaptive", display };
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        logger.error(`Ignoring MAX_THINKING_TOKENS: expected a non-negative integer, got '${raw}'.`);
        return { type: "adaptive", display };
    }
    return parsed === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: parsed, display };
}"""
if old not in s:
    sys.exit("acpx-thinking-patch: resolveThinkingConfig body changed upstream; update the patch")
open(p, "w").write(s.replace(old, new))
print("acpx-thinking-patch: patched", p)
PY
