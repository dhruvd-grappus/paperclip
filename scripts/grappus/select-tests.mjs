#!/usr/bin/env node
// Pick the test files that gate a Grappus overlay build, and optionally one
// shard of them. Prints JSON: { mode, since, shard, server: [...] }.
//
//   node scripts/grappus/select-tests.mjs [--since <sha>] [--shard <i>/<n>]
//
// Modes
//   full         every test file the fork touched since the upstream base tag
//                (scripts/grappus/BASE) plus the core suites below. Used when
//                --since is absent, not an ancestor of HEAD, or the range changes
//                anything outside server/ (shared packages, CI itself).
//   incremental  test files changed in <since>..HEAD, the tests next to every
//                changed source file (foo.ts -> foo.test.ts, foo.*.test.ts,
//                __tests__/foo*.test.ts), plus the core suites.
//
// The grappus gate is a fast unit-test gate. UI suites, end-to-end / integration
// suites (*.integration.test.ts), and any test measured above
// MAX_TEST_DURATION_MS in scripts/general-server-shard-durations.json are
// excluded; the full upstream suite runs in the regular PR/release gates. This
// keeps the overlay gate under a few minutes and makes it cheap to re-run when
// flakes hit.
//
// Sharding splits the server list greedily by measured duration so no single
// shard starves.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = readFileSync(path.join(ROOT, "scripts/grappus/BASE"), "utf8").trim();

// Always run: the fork's own regression suites for the native runner path.
// Kept small on purpose — heavy / embedded-postgres tests belong in the regular
// PR/release gate, not here.
const CORE_SERVER = [
  "src/__tests__/recovery-stale-issue-lock-sweep.test.ts",
  "src/services/runner-goals.test.ts",
];

// Tests the gate never runs. End-to-end / integration suites and the slow
// native-runtime / chat suites run in the regular PR/release gates, not here.
// Add patterns when a new e2e / integration suite ships so it does not
// silently land back in this gate.
const EXCLUDE_PATTERNS = [
  /\.integration\.test\.ts$/,
  /__tests__\/photon\//,
  /native-runtime\/.*\.test\.ts$/,
  /chat-channels\.test\.ts$/,
  /agent-conversations\.test\.ts$/,
  // 108-route mega-test that flakes under load and is not a small unit test.
  /issue-agent-mutation-ownership-routes\.test\.ts$/,
];

// A test that takes more than this is not a "small unit test" and belongs in
// the regular PR/release gate, not here. Durations come from
// scripts/general-server-shard-durations.json. Tests with no recorded
// duration stay in the gate (they are usually quick mocks).
const MAX_TEST_DURATION_MS = 5000;

function loadDurations() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, "scripts/general-server-shard-durations.json"), "utf8")).durations ?? {};
  } catch {
    return {};
  }
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}
function lines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}
function isTest(file) {
  return /\.test\.tsx?$/.test(file);
}
function isExcluded(file) {
  if (EXCLUDE_PATTERNS.some((re) => re.test(file))) return true;
  const durations = loadDurations();
  const ms = durations[`server/${file}`];
  return typeof ms === "number" && ms > MAX_TEST_DURATION_MS;
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

const allTests = lines(git("ls-files", "server/src/**/*.test.ts", "ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"))
  .filter((f) => !isExcluded(f));

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
  selected = new Set(lines(git("diff", "--name-only", `v${BASE}..HEAD`, "--", "*.test.ts", "*.test.tsx"))
    .filter((f) => !isExcluded(f)));
} else {
  selected = new Set(changed.filter(isTest).filter((f) => !isExcluded(f)));
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
for (const file of selected) {
  if (!existsSync(path.join(ROOT, file))) continue;
  if (file.startsWith("server/")) server.add(file.slice("server/".length));
}

let serverList = [...server]
  .filter((f) => existsSync(path.join(ROOT, "server", f)))
  .filter((f) => !isExcluded(f))
  .sort();

if (shardCount) {
  const durations = loadDurations();
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
}

process.stdout.write(JSON.stringify({ mode, since, shard: shardCount ? `${shardIndex}/${shardCount}` : null, server: serverList }, null, 2) + "\n");
