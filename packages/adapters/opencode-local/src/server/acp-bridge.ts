// Runs one OpenCode turn over ACP (`opencode acp`) and prints the turn as the
// JSONL events `opencode run --format json` emits, plus `reasoning_delta` and
// `text_delta` lines as the model streams. `opencode run` only prints a part
// once it is finished, so thinking reached the transcript tens of seconds
// late; ACP streams it chunk by chunk.
//
// Usage: node acp-bridge.js --command <opencode> [--model <provider/model>]
//          [--session <id>] [--cwd <dir>] [--print-logs]   (prompt on stdin)
//
// Executed directly by node (compiled .js in builds, type-stripped .ts in
// dev), so it imports node builtins only and uses erasable TypeScript syntax.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

function readArgs(argv: string[]) {
  const out = { command: "opencode", model: "", session: "", cwd: process.cwd(), printLogs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--print-logs") out.printLogs = true;
    else if (flag === "--command") out.command = argv[++i] ?? out.command;
    else if (flag === "--model") out.model = argv[++i] ?? "";
    else if (flag === "--session") out.session = argv[++i] ?? "";
    else if (flag === "--cwd") out.cwd = argv[++i] ?? out.cwd;
  }
  return out;
}

function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emit(event: Json) {
  process.stdout.write(`${JSON.stringify({ ...event, timestamp: Date.now() })}\n`);
}

function toolOutput(update: Json): string {
  const parts: string[] = [];
  for (const item of Array.isArray(update.content) ? update.content : []) {
    const entry = record(item);
    const inner = record(entry.content);
    const value = text(inner.text) || text(entry.text);
    if (value) parts.push(value);
  }
  if (parts.length > 0) return parts.join("\n");
  const raw = update.rawOutput;
  if (typeof raw === "string") return raw;
  const output = text(record(raw).output);
  return output;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const prompt = await readStdin();

  const child = spawn(args.command, args.printLogs ? ["acp", "--print-logs"] : ["acp"], {
    cwd: args.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      child.kill(signal);
      process.exit(1);
    });
  }

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  const write = (message: Json) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method: string, params: Json) =>
    new Promise<Json>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });

  let sessionId = args.session;
  let costUsd = 0;
  const tools = new Map<string, { name: string; input: unknown }>();

  const onUpdate = (update: Json) => {
    const kind = text(update.sessionUpdate);
    if (kind === "agent_thought_chunk" || kind === "agent_message_chunk") {
      const chunk = text(record(update.content).text);
      if (!chunk) return;
      emit({
        type: kind === "agent_thought_chunk" ? "reasoning_delta" : "text_delta",
        sessionID: sessionId,
        part: { messageID: text(update.messageId), text: chunk },
      });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = text(update.toolCallId);
      const known = tools.get(id);
      const tool = {
        name: known?.name || text(update.title) || text(update.kind) || "tool",
        input: update.rawInput ?? known?.input ?? {},
      };
      tools.set(id, tool);
      const status = text(update.status);
      if (status !== "completed" && status !== "failed") return;
      const output = toolOutput(update);
      emit({
        type: "tool_use",
        sessionID: sessionId,
        part: {
          tool: tool.name,
          callID: id,
          state: status === "completed"
            ? { status: "completed", input: tool.input, output }
            : { status: "error", input: tool.input, error: output || `${tool.name} failed` },
        },
      });
      return;
    }
    if (kind === "usage_update") {
      costUsd = num(record(update.cost).amount) || costUsd;
    }
  };

  const onRequest = (message: Json) => {
    if (message.method === "session/request_permission") {
      // Unattended runs approve like `opencode run --auto`: once, never "always".
      const options = Array.isArray(record(message.params).options) ? (record(message.params).options as unknown[]) : [];
      const pick = options.map(record).find((option) => option.kind === "allow_once")
        ?? options.map(record).find((option) => text(option.kind).startsWith("allow"));
      write({
        id: message.id,
        result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } },
      });
      return;
    }
    write({ id: message.id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
  };

  const exited = new Promise<never>((_, reject) => {
    child.on("error", (error) => reject(error));
    child.on("exit", (code, signal) => reject(new Error(`opencode acp exited (${signal ?? code})`)));
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let message: Json;
    try {
      message = JSON.parse(trimmed) as Json;
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "session/update") onUpdate(record(record(message.params).update));
      else if (message.id !== undefined) onRequest(message);
      return;
    }
    const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id as number);
    if (message.error) waiter.reject(new Error(text(record(message.error).message) || JSON.stringify(message.error)));
    else waiter.resolve(record(message.result));
  });
  const call = (method: string, params: Json) => Promise.race([request(method, params), exited]);

  try {
    await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (sessionId) {
      await call("session/resume", { sessionId, cwd: args.cwd, mcpServers: [] });
    } else {
      sessionId = text((await call("session/new", { cwd: args.cwd, mcpServers: [] })).sessionId);
    }
    if (args.model) {
      await call("session/set_config_option", { sessionId, configId: "model", value: args.model });
    }
    emit({ type: "step_start", sessionID: sessionId, part: { type: "step-start" } });
    const result = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    const usage = record(result.usage);
    emit({
      type: "step_finish",
      sessionID: sessionId,
      part: {
        reason: text(result.stopReason) || "end_turn",
        cost: costUsd,
        tokens: {
          input: num(usage.inputTokens),
          output: num(usage.outputTokens),
          reasoning: num(usage.thoughtTokens),
          cache: { read: num(usage.cachedReadTokens), write: num(usage.cachedWriteTokens) },
        },
      },
    });
    child.kill("SIGTERM");
    process.exit(0);
  } catch (error) {
    emit({
      type: "error",
      sessionID: sessionId || undefined,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
    child.kill("SIGTERM");
    process.exit(1);
  }
}

void main();
