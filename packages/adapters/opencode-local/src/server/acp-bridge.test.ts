import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "./parse.js";

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "acp-bridge.ts");

// A minimal `opencode acp`: logs every request it receives to $FAKE_ACP_LOG
// and plays one scripted turn (thought, permission request, tool call,
// message, usage) for session/prompt.
const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const log = (m) => fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(m) + "\\n");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
if (process.argv[2] !== "acp") process.exit(2);
process.stdout.write("opencode acp starting\\n");
let promptId = null;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1 } });
  if (m.method === "session/new") return send({ id: m.id, result: { sessionId: "ses_new" } });
  if (m.method === "session/resume") {
    if (m.params.sessionId === "ses_gone") {
      return send({ id: m.id, error: { code: -32602, message: "Invalid params: session not found: ses_gone" } });
    }
    return send({ id: m.id, result: {} });
  }
  if (m.method === "session/set_config_option") return send({ id: m.id, result: { configOptions: [] } });
  if (m.method === "session/prompt") {
    promptId = m.id;
    const s = m.params.sessionId;
    update(s, { sessionUpdate: "agent_thought_chunk", messageId: "r1", content: { type: "text", text: "Let me " } });
    update(s, { sessionUpdate: "agent_thought_chunk", messageId: "r1", content: { type: "text", text: "think." } });
    update(s, { sessionUpdate: "tool_call", toolCallId: "t1", title: "shell", kind: "execute", status: "pending", rawInput: {} });
    return send({ id: 900, method: "session/request_permission", params: { sessionId: s, options: [
      { optionId: "always", kind: "allow_always" }, { optionId: "once", kind: "allow_once" }, { optionId: "no", kind: "reject_once" },
    ] } });
  }
  if (m.id === 900) {
    const s = "ses_any";
    update(s, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", title: "echo hi", rawInput: { command: "echo hi" } });
    update(s, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi\\n" } }] });
    update(s, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "All " } });
    update(s, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "done." } });
    update(s, { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.25, currency: "USD" } });
    return send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, totalTokens: 170 } } });
  }
});
`;

describe("OpenCode ACP bridge", () => {
  let root: string;
  let command: string;
  let logPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-acp-"));
    command = path.join(root, "opencode");
    logPath = path.join(root, "requests.jsonl");
    await fs.writeFile(command, FAKE_OPENCODE, { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function runBridge(extra: string[]) {
    const proc = spawnSync(process.execPath, [bridge, "--command", command, "--cwd", root, ...extra], {
      input: "Do the task.",
      env: { ...process.env, FAKE_ACP_LOG: logPath },
      encoding: "utf8",
      timeout: 15_000,
    });
    const events = proc.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { proc, events };
  }

  async function requests() {
    const lines = (await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  }

  it("streams thinking and text deltas and ends with run-format tool and usage events", async () => {
    const { proc, events } = runBridge(["--model", "opencode-go/glm-5.3-flash"]);

    expect(proc.status).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "step_start",
      "reasoning_delta",
      "reasoning_delta",
      "tool_use",
      "text_delta",
      "text_delta",
      "step_finish",
    ]);
    expect(events[1].part.text + events[2].part.text).toBe("Let me think.");
    expect(events[3].part).toEqual({
      tool: "shell",
      callID: "t1",
      state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" },
    });
    expect(events[6].part).toMatchObject({
      reason: "end_turn",
      cost: 0.25,
      tokens: { input: 100, output: 20, cache: { read: 50 } },
    });

    const parsed = parseOpenCodeJsonl(proc.stdout);
    expect(parsed.sessionId).toBe("ses_new");
    expect(parsed.summary).toBe("All done.");
    expect(parsed.usage).toEqual({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 });
    expect(parsed.costUsd).toBe(0.25);

    const sent = await requests();
    expect(sent.find((m) => m.method === "session/set_config_option")?.params).toEqual({
      sessionId: "ses_new",
      configId: "model",
      value: "opencode-go/glm-5.3-flash",
    });
    expect(sent.find((m) => m.method === "session/prompt")?.params.prompt).toEqual([
      { type: "text", text: "Do the task." },
    ]);
    expect(sent.find((m) => m.id === 900)?.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
  });

  it("resumes a saved session instead of creating one", async () => {
    const { proc } = runBridge(["--session", "ses_saved"]);

    expect(proc.status).toBe(0);
    const sent = await requests();
    expect(sent.some((m) => m.method === "session/new")).toBe(false);
    expect(sent.find((m) => m.method === "session/resume")?.params).toMatchObject({ sessionId: "ses_saved", cwd: root });
    expect(sent.some((m) => m.method === "session/set_config_option")).toBe(false);
  });

  it("reports a missing session as an error the adapter retries fresh", async () => {
    const { proc } = runBridge(["--session", "ses_gone"]);

    expect(proc.status).toBe(1);
    const parsed = parseOpenCodeJsonl(proc.stdout);
    expect(parsed.errorMessage).toContain("session not found: ses_gone");
    expect(isOpenCodeUnknownSessionError(proc.stdout, proc.stderr)).toBe(true);
  });
});
