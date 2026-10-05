#!/usr/bin/env node
// Pick the test files that gate a Grappus overlay build, and optionally one
// shard of them. Prints JSON: { mode, since, shard, server: [...], ui: [...] }.
//
//   node scripts/grappus/select-tests.mjs [--since <sha>] [--shard <i>/<n>]
//
// Modes
//   full         every test file the fork touched since the upstream base tag
//                (scripts/grappus/BASE) plus the core suites below. Used when
//                --since is absent, not an ancestor of HEAD, or the range changes
//                anything outside server/ and ui/ (shared packages, CI itself).
//   incremental  test files changed in <since>..HEAD, the tests next to every
//                changed source file (foo.ts -> foo.test.ts, foo.*.test.ts,
//                __tests__/foo*.test.ts), plus the core suites.
//
// Sharding splits the server list greedily by measured duration
// (scripts/general-server-shard-durations.json; unknown files weigh the median)
// so the one 10-minute integration suite does not sit beside three others. UI
// tests are cheap and always go to shard 1.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = readFileSync(path.join(ROOT, "scripts/grappus/BASE"), "utf8").trim();

// Always run: the fork's own regression suites for the native runner path.
const CORE_SERVER = [
  "src/__tests__/recovery-stale-issue-lock-sweep.test.ts",
  "src/__tests__/heartbeat-process-recovery.test.ts",
  "src/__tests__/agent-conversations.test.ts",
  "src/services/runner-goals.test.ts",
];
const CORE_UI = ["src/components/Sidebar.test.tsx"];

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}
function lines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}
function isTest(file) {
  return /\.test\.tsx?$/.test(file);
}

const args = process.argv.slice(2);
let since = null;
let shardIndex = null;
let shardCount = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since") since = args[++i] || null;
  else if (args[i] === "--shard") {
    const m = /^(\d+)\/(\d+)$/.exec(args[++i] ?? "");
    if (!m) throw new Error("--shard expects <i>/<n>");
    shardIndex = Number(m[1]);
    shardCount = Number(m[2]);
    if (shardIndex < 1 || shardIndex > shardCount) throw new Error("--shard index out of range");
  } else throw new Error(`unknown argument ${args[i]}`);
}

const allTests = lines(git("ls-files", "server/src/**/*.test.ts", "ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"));

let mode = "full";
let changed = [];
if (since) {
  let ancestor = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", since, "HEAD"], { cwd: ROOT, stdio: "ignore" });
    ancestor = true;
  } catch {}
  if (ancestor && git("rev-parse", since) !== git("rev-parse", "HEAD")) {
    changed = lines(git("diff", "--name-only", `${since}..HEAD`));
    const outside = changed.filter((f) => !f.startsWith("server/") && !f.startsWith("ui/"));
    mode = outside.length === 0 ? "incremental" : "full";
  } else if (ancestor) {
    changed = [];
    mode = "incremental"; // nothing changed: core suites only
  }
}

let selected;
if (mode === "full") {
  selected = new Set(lines(git("diff", "--name-only", `v${BASE}..HEAD`, "--", "*.test.ts", "*.test.tsx")));
} else {
  selected = new Set(changed.filter(isTest));
  for (const file of changed) {
    if (isTest(file)) continue;
    const ext = path.extname(file);
    if (![".ts", ".tsx", ".js", ".mjs"].includes(ext)) continue;
    const dir = path.dirname(file);
    const stem = path.basename(file, ext);
    const top = file.startsWith("server/") ? "server" : "ui";
    for (const test of allTests) {
      if (!test.startsWith(`${top}/`)) continue;
      const tdir = path.dirname(test);
      const tbase = path.basename(test);
      const sibling = tdir === dir && (tbase === `${stem}.test${ext}` || tbase.startsWith(`${stem}.`) && isTest(tbase));
      const underTests = tdir === `${top}/src/__tests__` && tbase.startsWith(stem);
      if (sibling || underTests) selected.add(test);
    }
  }
}

const server = new Set(CORE_SERVER);
const ui = new Set(CORE_UI);
for (const file of selected) {
  if (!existsSync(path.join(ROOT, file))) continue;
  if (file.startsWith("server/")) server.add(file.slice("server/".length));
  else if (file.startsWith("ui/")) ui.add(file.slice("ui/".length));
}

let serverList = [...server].filter((f) => existsSync(path.join(ROOT, "server", f))).sort();
let uiList = [...ui].filter((f) => existsSync(path.join(ROOT, "ui", f))).sort();

if (shardCount) {
  let durations = {};
  try {
    durations = JSON.parse(readFileSync(path.join(ROOT, "scripts/general-server-shard-durations.json"), "utf8")).durations ?? {};
  } catch {}
  const known = Object.values(durations).sort((a, b) => a - b);
  const median = known.length ? known[known.length >> 1] : 1000;
  const weight = (f) => durations[`server/${f}`] ?? median;
  const bins = Array.from({ length: shardCount }, () => ({ load: 0, files: [] }));
  for (const f of [...serverList].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const bin = bins.reduce((min, b) => (b.load < min.load ? b : min), bins[0]);
    bin.files.push(f);
    bin.load += weight(f);
  }
  serverList = bins[shardIndex - 1].files.sort();
  if (shardIndex !== 1) uiList = [];
}

process.stdout.write(JSON.stringify({ mode, since, shard: shardCount ? `${shardIndex}/${shardCount}` : null, server: serverList, ui: uiList }, null, 2) + "\n");
