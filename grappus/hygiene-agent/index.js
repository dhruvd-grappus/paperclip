#!/usr/bin/env node
/**
 * HygieneAgent: deterministic health and hygiene checks for a Paperclip company + host.
 * Runs under the Paperclip `process` adapter on a timer. No LLM.
 *
 * Checks
 *   system   server health endpoint, backups (Paperclip + host cron), disk, memory, load, service uptime, TLS expiry, worktree dir
 *   agents   failed heartbeat runs (24h), slow runs, budget utilisation, paused/error agents, stale agents
 *   issues   stale in_progress, old blocked, waiting on human too long, missing project, orphan children, done with open children
 *   flow     cycle time (7d), time in review, bounce loops (changes requested), plan-gate wait
 *   chat     chat endpoint status / errors
 *
 * Output: `latest` document + comment on the standing issue "Hygiene report"; priority reflects worst finding.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

import os from "node:os";
import path from "node:path";
const API = (process.env.PAPERCLIP_API_URL || "https://187.126.114.172.sslip.io").replace(/\/$/, "").replace(/\/api$/, "");
let KEY = process.env.PAPERCLIP_API_KEY;
if (!KEY) { try { KEY = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".paperclip/auth.json"), "utf8")).credentials[API].token; } catch {} }
const OUT = process.env.HYGIENE_OUT || "";
const RUN = process.env.PAPERCLIP_RUN_ID;
const COMPANY = process.env.PAPERCLIP_COMPANY_ID || "d255c3a4-2066-4d81-8c40-862ad8208963";
const ME = process.env.PAPERCLIP_AGENT_ID || "";
const PUBLIC_URL = process.env.HYGIENE_PUBLIC_HOST || "187.126.114.172.sslip.io";
const HOST_BACKUP_DIR = process.env.HYGIENE_HOST_BACKUP_DIR || "/var/backups/paperclip";
const WORKTREES = process.env.HYGIENE_WORKTREES_DIR || "/home/paperclip/worktrees";

const LIMITS = {
  staleInProgressH: Number(process.env.HYGIENE_STALE_H || 6),
  blockedOldH: 24,
  waitingHumanH: 24,
  diskWarnPct: 80, diskCritPct: 92,
  memWarnPct: 85,
  backupStaleH: 26,
  runFailWarnPct: 20,
  slowRunMin: 20,
  budgetWarnPct: 80,
  tlsWarnDays: 14,
  bounceWarn: 3,
};

const H = 3600e3;
const now = Date.now();
const hoursAgo = (iso) => (iso ? (now - new Date(iso).getTime()) / H : Infinity);
const fmtH = (h) => (h === Infinity ? "n/a" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);

const findings = []; // {level: crit|warn|ok|info, area, text}
const add = (level, area, text, group) => findings.push({ level, area, text, group });
const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8", timeout: 15000 }).trim(); } catch { return ""; } };

async function pc(method, path, body) {
  const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(RUN ? { "X-Paperclip-Run-Id": RUN } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${typeof j === "string" ? j.slice(0, 900) : JSON.stringify(j).slice(0, 900)}`);
  return j;
}
async function safe(fn, fallback) { try { return await fn(); } catch (e) { add("info", "api", `skipped: ${e.message.slice(0, 120)}`); return fallback; } }

// ---------------- system ----------------
async function checkSystem() {
  const health = await safe(() => pc("GET", "/api/health"), null);
  if (!health) add("crit", "system", "health endpoint unreachable");
  else {
    add(health.status === "ok" ? "ok" : "crit", "system", `server ${health.status}, ${health.deploymentMode}/${health.deploymentExposure}, v${health.version || health.serverVersion || "?"}`);
    for (const w of health.warnings || []) add(w.code === "database_backup_stale" || w.code === "database_backup_missing" ? "warn" : "info", "system", `server warning: ${w.message}`);
    const lb = health.databaseBackup?.latestBackup;
    if (lb) add(lb.ageHours > LIMITS.backupStaleH ? "warn" : "ok", "backup", `Paperclip logical backup ${fmtH(lb.ageHours)} old (${(lb.sizeBytes / 1e6).toFixed(1)} MB)`);
    if (health.serverInfo?.processStartedAt) add("info", "system", `server up ${fmtH(hoursAgo(health.serverInfo.processStartedAt))}`);
  }
  // host backup cron
  try {
    const files = fs.readdirSync(HOST_BACKUP_DIR).filter((f) => f.startsWith("db-")).map((f) => ({ f, m: fs.statSync(`${HOST_BACKUP_DIR}/${f}`).mtimeMs })).sort((a, b) => b.m - a.m);
    if (!files.length) add("warn", "backup", `no host pg_dump backups in ${HOST_BACKUP_DIR}`);
    else { const age = (now - files[0].m) / H; add(age > LIMITS.backupStaleH ? "warn" : "ok", "backup", `host pg_dump ${fmtH(age)} old, ${files.length} kept`); }
  } catch { add("info", "backup", `host backup dir not readable: ${HOST_BACKUP_DIR}`); }
  // disk
  const df = sh("df -P / | tail -1").split(/\s+/);
  if (df.length >= 5) { const pct = parseInt(df[4]); add(pct >= LIMITS.diskCritPct ? "crit" : pct >= LIMITS.diskWarnPct ? "warn" : "ok", "host", `disk / ${pct}% used (${df[3]} KB free)`); }
  // memory + load
  const mem = sh("free -m | awk '/Mem:/{print $2, $3, $7}'").split(" ").map(Number);
  if (mem.length === 3) { const pct = Math.round((1 - mem[2] / mem[0]) * 100); add(pct >= LIMITS.memWarnPct ? "warn" : "ok", "host", `memory ${pct}% in use (${mem[2]} MB available of ${mem[0]})`); }
  const load = sh("cat /proc/loadavg").split(" ").slice(0, 3).join(" "); const cores = Number(sh("nproc")) || 1;
  if (load) { const l1 = parseFloat(load); add(l1 > cores * 1.5 ? "warn" : "ok", "host", `load ${load} on ${cores} cores`); }
  // services
  for (const svc of ["paperclip", "postgresql", "caddy"]) { const st = sh(`systemctl is-active ${svc}`); add(st === "active" ? "ok" : "crit", "host", `${svc} service ${st || "unknown"}`); }
  // TLS
  const notAfter = sh(`echo | openssl s_client -servername ${PUBLIC_URL} -connect ${PUBLIC_URL}:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2`);
  if (notAfter) { const days = (new Date(notAfter).getTime() - now) / (24 * H); add(days < LIMITS.tlsWarnDays ? "warn" : "ok", "host", `TLS cert expires in ${days.toFixed(0)} days`); }
  // worktrees
  try { const n = fs.readdirSync(WORKTREES).length; const size = sh(`du -sm ${WORKTREES} 2>/dev/null | cut -f1`); add(n > 30 ? "warn" : "info", "host", `${n} worktrees, ${size || "?"} MB in ${WORKTREES}`); } catch {}
  const pg = sh("pg_isready -q && echo ok"); if (pg !== "ok") add("crit", "host", "postgres not accepting connections");
}

// ---------------- agents ----------------
async function checkAgents() {
  const agents = await safe(() => pc("GET", `/api/companies/${COMPANY}/agents`), []);
  const runsAll = await safe(() => pc("GET", `/api/companies/${COMPANY}/heartbeat-runs`), []);
  const runs = (Array.isArray(runsAll) ? runsAll : runsAll.runs || runsAll.items || []).filter((r) => hoursAgo(r.createdAt || r.startedAt) <= 24);
  const byAgent = {};
  for (const r of runs) { (byAgent[r.agentId] ||= []).push(r); }
  let totalFail = 0;
  for (const a of agents) {
    const rs = byAgent[a.id] || [];
    const failed = rs.filter((r) => r.status === "failed").length; totalFail += failed;
    const durs = rs.filter((r) => r.finishedAt && r.startedAt).map((r) => (new Date(r.finishedAt) - new Date(r.startedAt)) / 60e3);
    const avg = durs.length ? durs.reduce((x, y) => x + y, 0) / durs.length : 0;
    const slow = durs.filter((d) => d > LIMITS.slowRunMin).length;
    const spend = a.spentMonthlyCents || 0, budget = a.budgetMonthlyCents || 0;
    const util = budget ? Math.round((spend / budget) * 100) : null;
    const bits = [`${rs.length} runs/24h`, `${failed} failed`, durs.length ? `avg ${avg.toFixed(1)}m` : null, slow ? `${slow} slow` : null, util !== null ? `budget ${util}%` : `spend $${(spend / 100).toFixed(2)}`].filter(Boolean).join(", ");
    let level = "ok";
    if (a.status === "error") level = "crit";
    else if (a.status === "paused") level = "info";
    else if (rs.length && failed / rs.length >= LIMITS.runFailWarnPct / 100) level = "warn";
    else if (util !== null && util >= LIMITS.budgetWarnPct) level = "warn";
    const failWarn = rs.length >= 3 && failed / rs.length >= LIMITS.runFailWarnPct / 100;
    if (level === "crit" || (level === "warn" && !failWarn)) add(level, "agents", `${a.name}: ${bits}`); else if (rs.length) add("info", "agents", `${a.name}: ${bits}`);
    const failMsgs = [...new Set(rs.filter((x) => x.status === "failed").map((r) => (r.error || r.errorCode || "unknown").toString().slice(0, 90)))].slice(0, 2);
    if (rs.length >= 3 && failed / rs.length >= LIMITS.runFailWarnPct / 100) add("warn", "agents", `${a.name} ${failed}/${rs.length} runs failed: ${failMsgs.join(" | ")}`, "agent failures");
    else if (failed) add("info", "agents", `${a.name} ${failed} failed: ${failMsgs.join(" | ")}`, "agent failures");
  }
  add("info", "agents", `${runs.length} runs in 24h, ${totalFail} failed`, "_summary");
}

// ---------------- issues ----------------
async function checkIssues() {
  const all = await safe(() => pc("GET", `/api/companies/${COMPANY}/issues`), []);
  const issues = (all || []).filter((i) => !i.title.startsWith("Vault:") && i.title !== "Hygiene report");
  const byId = Object.fromEntries(issues.map((i) => [i.id, i]));
  const open = issues.filter((i) => !["done", "cancelled"].includes(i.status));
  add("info", "issues", `${open.length} open of ${issues.length} total (${count(open, "todo")} todo, ${count(open, "in_progress")} in progress, ${count(open, "in_review")} in review, ${count(open, "blocked")} blocked)`);

  for (const i of open) {
    const age = hoursAgo(i.updatedAt);
    if (i.status === "in_progress" && age > LIMITS.staleInProgressH) add("warn", "issues", `${i.identifier} (${fmtH(age)})`, "in progress with no update");
    if (i.status === "blocked" && age > LIMITS.blockedOldH) add("warn", "issues", `${i.identifier} (${fmtH(age)})`, "blocked for over a day");
    if (!i.projectId && !i.parentId) add(hoursAgo(i.createdAt) > 24 ? "warn" : "info", "issues", i.identifier, "no project");
    if (i.parentId && !byId[i.parentId]) add("warn", "issues", i.identifier, "parent missing");
    if (!i.assigneeAgentId && !i.assigneeUserId && i.status !== "todo") add("warn", "issues", `${i.identifier} (${i.status})`, "unassigned but active");
  }
  // waiting on humans
  for (const i of open.filter((x) => x.status === "in_review")) {
    const inter = await safe(() => pc("GET", `/api/issues/${i.id}/interactions`), []);
    const pending = (inter || []).filter((x) => x.status === "pending");
    for (const p of pending) { const age = hoursAgo(p.createdAt); if (age > LIMITS.waitingHumanH) add("warn", "issues", `${i.identifier} (${fmtH(age)})`, "waiting on a human for over a day"); }
    if (!pending.length && hoursAgo(i.updatedAt) > LIMITS.waitingHumanH) add("warn", "issues", `${i.identifier} (${fmtH(hoursAgo(i.updatedAt))})`, "in review with nothing pending");
  }
  // done parents with open children
  for (const i of issues.filter((x) => x.status === "done")) {
    const kids = open.filter((k) => k.parentId === i.id);
    if (kids.length) add("warn", "issues", `${i.identifier} (${kids.length} open)`, "done but children still open");
  }
  return issues;
}
const count = (arr, s) => arr.filter((i) => i.status === s).length;
const trunc = (s, n) => ((s || "").length > n ? s.slice(0, n) + "…" : s || "");

// ---------------- board: running / blocked / waiting ----------------
const board = { running: [], blocked: [], waiting: [] };
async function checkBoard(issues, agents) {
  const byAgent = Object.fromEntries((agents || []).map((a) => [a.id, a]));
  const runsAll = await safe(() => pc("GET", `/api/companies/${COMPANY}/heartbeat-runs`), []);
  const live = new Set((Array.isArray(runsAll) ? runsAll : runsAll.runs || []).filter((r) => r.status === "running").map((r) => r.issueId || r.taskId).filter(Boolean));
  for (const i of issues.filter((x) => ["in_progress", "blocked", "in_review"].includes(x.status))) {
    const who = i.assigneeAgentId ? byAgent[i.assigneeAgentId]?.name || "agent" : i.assigneeUserId ? "user" : "unassigned";
    const age = fmtH(hoursAgo(i.updatedAt));
    const row = { id: i.identifier, title: trunc(i.title, 70), who, age, live: live.has(i.id), issue: i };
    if (i.status === "in_progress") board.running.push(row);
    else if (i.status === "blocked") board.blocked.push(row);
    else board.waiting.push(row);
  }
  for (const r of board.blocked) {
    const cs = await safe(() => pc("GET", `/api/issues/${r.issue.id}/comments`), []);
    const last = (cs || []).slice(-1)[0];
    r.reason = trunc((last?.body || "").replace(/\s+/g, " "), 120) || "no reason recorded";
    const b = r.issue.blockedBy || r.issue.blockers || [];
    if (Array.isArray(b) && b.length) r.reason = `blocked by ${b.map((x) => x.identifier || x).join(", ")}; ` + r.reason;
  }
  for (const r of board.waiting) {
    const inter = await safe(() => pc("GET", `/api/issues/${r.issue.id}/interactions`), []);
    const p = (inter || []).find((x) => x.status === "pending");
    r.reason = p ? `awaiting "${p.title || p.kind}" for ${fmtH(hoursAgo(p.createdAt))}` : "in review, nothing pending";
  }
}

// ---------------- Jev judgement (optional) ----------------
async function judgeWithJev(issues) {
  if (!process.env.TYPESAFE_API_KEY) return null;
  let TypeSafeClient;
  try { ({ TypeSafeClient } = await import("@typesafe-ai/sdk")); } catch { return null; }
  const client = new TypeSafeClient();
  const active = [...board.running, ...board.blocked, ...board.waiting].slice(0, 12);
  const items = [];
  for (const r of active) {
    const cs = await safe(() => pc("GET", `/api/issues/${r.issue.id}/comments`), []);
    items.push({ id: r.id, status: r.issue.status, title: r.issue.title, assignee: r.who, idle_for: r.age, last_comments: (cs || []).slice(-4).map((c) => trunc((c.body || "").replace(/\s+/g, " "), 300)) });
  }
  const hostSummary = findings.filter((f) => ["system", "host", "backup", "agents", "chat"].includes(f.area) && !/HygieneAgent/.test(f.text)).map((f) => `${f.level}: ${f.text}`);
  const questions = {
    overall: { type: "score", instructions: "Overall health of this Paperclip company right now, given `host_and_agents` and `active_issues`.", criteria: ["Healthy: nothing needs a human today", "Degraded: a human should look within a day", "Unhealthy: work is stuck or infrastructure is at risk, act now"] },
  };
  items.forEach((it, i) => {
    questions[`stuck_${i}`] = { type: "noul", instructions: { item: `active_issues[${i}]`, question: "Is `item` genuinely stuck (no progress possible without a human or another agent acting), as opposed to simply waiting a normal amount of time?" } };
    questions[`human_${i}`] = { type: "noul", instructions: { item: `active_issues[${i}]`, question: "Does `item` need a human decision or answer to move forward?" } };
  });
  const res = await client.systemOne({ state: { host_and_agents: hostSummary, active_issues: items }, model: "jev-latest", questions });
  const a = res.answers;
  const out = { overall: a.overall, stuck: [] };
  items.forEach((it, i) => { const s_ = a[`stuck_${i}`].noul, h = a[`human_${i}`].noul; if (s_ >= 0.7 || h >= 0.7) out.stuck.push({ id: it.id, title: trunc(it.title, 60), stuck: s_, human: h }); });
  return out;
}

// ---------------- flow ----------------
async function checkFlow(issues) {
  const week = issues.filter((i) => hoursAgo(i.createdAt) <= 24 * 7 && !i.parentId);
  const done = week.filter((i) => i.status === "done");
  if (done.length) {
    const cts = done.map((i) => (new Date(i.updatedAt) - new Date(i.createdAt)) / H).sort((a, b) => a - b);
    const med = cts[Math.floor(cts.length / 2)];
    add("info", "flow", `7d: ${week.length} tasks opened, ${done.length} done, median cycle ${fmtH(med)}, slowest ${fmtH(cts[cts.length - 1])}`);
  } else add("info", "flow", `7d: ${week.length} tasks opened, none done yet`);
  // bounce loops: count "Changes requested" comments per open child
  const active = issues.filter((i) => ["in_progress", "in_review"].includes(i.status)).slice(0, 25);
  for (const i of active) {
    const cs = await safe(() => pc("GET", `/api/issues/${i.id}/comments`), []);
    const bounces = (cs || []).filter((c) => /^changes requested/i.test((c.body || "").trim())).length;
    if (bounces >= LIMITS.bounceWarn) add("warn", "flow", `${i.identifier} bounced ${bounces}× between reviewers and Executor: ${trunc(i.title, 50)}`);
    const gate = (cs || []).find((c) => /plan approval/i.test(c.body || ""));
    if (gate && i.status === "in_review" && hoursAgo(gate.createdAt) > LIMITS.waitingHumanH) add("warn", "flow", `${i.identifier} plan gate open ${fmtH(hoursAgo(gate.createdAt))}`);
  }
}

// ---------------- chat ----------------
async function checkChat() {
  const eps = await safe(() => pc("GET", `/api/companies/${COMPANY}/chat-endpoints`), []);
  for (const e of eps || []) {
    const lvl = e.status === "active" ? "ok" : e.status === "draft" || e.status === "verifying" ? "warn" : "crit";
    add(lvl, "chat", `${e.provider} endpoint "${e.name || e.botLabel}" ${e.status}${e.lastError ? ": " + trunc(e.lastError, 100) : ""}${e.lastActivityAt ? ", last activity " + fmtH(hoursAgo(e.lastActivityAt)) + " ago" : ""}`);
  }
}

// ---------------- report ----------------
async function standingIssue() {
  const pinned = process.env.HYGIENE_ISSUE_ID || process.env.PAPERCLIP_TASK_ID;
  if (pinned) { try { const i = await pc("GET", `/api/issues/${pinned}`); if (i?.id) return i; } catch {} }
  const mine = await safe(() => pc("GET", `/api/companies/${COMPANY}/issues?assigneeAgentId=${ME}`), []);
  let found = (mine || []).find((h) => h.title === "Hygiene report");
  if (found) return found;
  const hits = await safe(() => pc("GET", `/api/companies/${COMPANY}/issues?q=${encodeURIComponent("Hygiene report")}`), []);
  found = (hits || []).find((h) => h.title === "Hygiene report");
  if (found) return found;
  throw new Error("standing issue 'Hygiene report' not found; set HYGIENE_ISSUE_ID in adapter env");
}

function worst(area) { const lv = findings.filter((f) => f.area === area).map((f) => f.level); return lv.includes("crit") ? "crit" : lv.includes("warn") ? "warn" : "ok"; }
const ICON = { crit: "🔴", warn: "🟠", ok: "🟢", info: "⚪" };
function grouped(list) {
  const out = [], groups = new Map();
  for (const f of list) {
    if (!f.group || f.group.startsWith("_")) { out.push(`${ICON[f.level]} ${f.text}`); continue; }
    const g = groups.get(f.group) || { level: f.level, items: [] };
    if (f.level === "crit") g.level = "crit"; else if (f.level === "warn" && g.level !== "crit") g.level = "warn";
    g.items.push(f.text); groups.set(f.group, g);
  }
  for (const [name, g] of groups) out.push(`${ICON[g.level]} ${g.items.length} ${name}: ${g.items.slice(0, 8).join(", ")}${g.items.length > 8 ? ` +${g.items.length - 8}` : ""}`);
  return out;
}
function render() {
  const crit = findings.filter((f) => f.level === "crit" && f.area !== "verdict"), warn = findings.filter((f) => f.level === "warn" && f.area !== "verdict");
  const status = crit.length ? "🔴 act now" : warn.length ? "🟠 needs a look" : "🟢 all clear";
  const areas = [["System & host", ["system", "host", "backup"]], ["Agents", ["agents"]], ["Issues & flow", ["issues", "flow"]], ["Chat", ["chat"]]];
  const areaLine = areas.map(([label, keys]) => { const lv = keys.map(worst); const w = lv.includes("crit") ? "crit" : lv.includes("warn") ? "warn" : "ok"; return `${ICON[w]} ${label}`; }).join(" · ");
  const verdict = findings.find((f) => f.area === "verdict" && f.text.startsWith("Jev overall"));
  const lines = [`# Hygiene report`, ``, `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC · **${status}** · ${board.running.length} running · ${board.blocked.length} blocked · ${board.waiting.length} waiting on you`, ``, areaLine + (verdict ? ` · ${ICON[verdict.level]} Jev: ${verdict.text.replace("Jev overall: ", "")}` : ""), ``];
  const attention = grouped([...crit, ...warn].filter((f) => f.area !== "verdict"));
  const stuck = findings.filter((f) => f.area === "verdict" && !f.text.startsWith("Jev overall")).map((f) => `${ICON[f.level]} ${f.text}`);
  if (attention.length || stuck.length) lines.push(`## Needs attention`, ...attention, ...stuck, ``);
  lines.push(`## Board`);
  const row = (r, extra) => `- ${r.id} · ${r.who} · ${r.age} · ${trunc(r.title, 60)}${extra ? ` — ${trunc(extra, 90)}` : ""}`;
  if (board.running.length) lines.push(`Running`, ...board.running.map((r) => row(r, r.live ? "run active" : "")));
  if (board.blocked.length) lines.push(`Blocked`, ...board.blocked.map((r) => row(r, r.reason)));
  if (board.waiting.length) lines.push(`Waiting on a human`, ...board.waiting.map((r) => row(r, r.reason)));
  if (!board.running.length && !board.blocked.length && !board.waiting.length) lines.push(`- nothing active`);
  lines.push(``);
  const pick = (area, re) => (findings.find((f) => f.area === area && re.test(f.text)) || {}).text || "";
  const m = (t, re) => { const x = re.exec(t); return x ? x[1] : "?"; };
  const metrics = [
    `disk ${m(pick("host", /^disk/), /disk \/ (\d+%)/)}`,
    `mem ${m(pick("host", /^memory/), /memory (\d+%)/)}`,
    `load ${m(pick("host", /^load/), /load ([\d.]+)/)}`,
    `TLS ${m(pick("host", /^TLS/), /in (\d+) days/)}d`,
    `backup ${m(pick("backup", /^Paperclip/), /backup (\S+) old/)}`,
    `runs/24h ${m(pick("agents", /runs in 24h/), /(\d+ runs in 24h, \d+ failed)/)}`,
    pick("flow", /^7d/).replace(/^7d: /, "7d "),
  ].filter((x) => !/\?/.test(x));
  lines.push(`## Metrics`, `- ${metrics.join(" · ")}`, ``);
  const chat = findings.filter((f) => f.area === "chat").map((f) => `${ICON[f.level]} ${f.text}`);
  if (chat.length) lines.push(`## Chat`, ...chat, ``);
  const api = findings.filter((f) => f.area === "api");
  if (api.length) lines.push(`_${api.length} check(s) skipped (permissions)._`);
  return { md: lines.join("\n"), headline: status, crit: crit.length, warn: warn.length };
}

function esc(t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function inline(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\b(GRA-\d+)\b/g, `<a href="${API}/GRA/issues/$1">$1</a>`); }
function htmlPage(md, headline) {
  const body = []; let inList = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("- ")) { if (!inList) { body.push("<ul>"); inList = true; } body.push(`<li>${inline(line.slice(2))}</li>`); continue; }
    if (inList) { body.push("</ul>"); inList = false; }
    if (line.startsWith("# ")) body.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith("## ")) body.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith("_") && line.endsWith("_")) body.push(`<p class="muted">${inline(line.slice(1, -1))}</p>`);
    else if (line.trim()) body.push(`<p>${inline(line)}</p>`);
  }
  if (inList) body.push("</ul>");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="300"><title>Hygiene · ${esc(headline)}</title>
<style>body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1b2233;background:#f6f5f0}h1{font-size:1.6rem;margin:.2rem 0}h2{font-size:1.05rem;margin:1.4rem 0 .4rem;border-bottom:1px solid #d9d6cc;padding-bottom:.2rem}ul{padding-left:1.2rem;margin:.3rem 0}li{margin:.15rem 0}code{background:#eef0ea;padding:.05em .3em;border-radius:3px}a{color:#4a154b}.muted{color:#5a6272;font-size:.9rem}p{margin:.4rem 0}</style></head><body>${body.join("\n")}<p class="muted">Auto-refreshes every 5 min · <a href="latest.md">markdown</a> · <a href="latest.json">json</a></p></body></html>`;
}

async function main() {
  await checkSystem();
  await checkAgents();
  const issues = await checkIssues();
  const agents = await safe(() => pc("GET", `/api/companies/${COMPANY}/agents`), []);
  await checkBoard(issues, agents);
  await checkFlow(issues);
  await checkChat();
  let jev = null;
  try { jev = await judgeWithJev(issues); } catch (e) { add("info", "api", `jev skipped: ${e.message.slice(0, 100)}`); }
  if (jev) {
    const lvl = jev.overall.score >= 1.5 ? "warn" : jev.overall.score >= 0.75 ? "warn" : "ok"; // advisory: never escalates the headline alone
    add(lvl, "verdict", `Jev overall: ${["healthy", "degraded", "unhealthy"][Math.round(Math.min(2, jev.overall.score))]} (${(jev.overall.confidence * 100).toFixed(0)}% confidence)`);
    for (const s_ of jev.stuck) add("warn", "verdict", `${s_.id} ${s_.stuck >= 0.7 ? "stuck" : ""}${s_.stuck >= 0.7 && s_.human >= 0.7 ? " and " : ""}${s_.human >= 0.7 ? "needs a human" : ""} (${Math.round(Math.max(s_.stuck, s_.human) * 100)}%): ${s_.title}`);
  }
  const { md, headline, crit, warn } = render();
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of ["latest.md", "latest.json", "index.html"]) { try { fs.chmodSync(path.join(OUT, f), 0o644); } catch {} }
    fs.writeFileSync(path.join(OUT, "latest.md"), md, { mode: 0o644 });
    fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), headline, crit, warn, board, findings }, null, 2));
    fs.writeFileSync(path.join(OUT, "index.html"), htmlPage(md, headline), { mode: 0o644 });
  } else {
    const issue = await standingIssue();
    let base = null;
    try { const cur = await pc("GET", `/api/issues/${issue.id}/documents/latest`); base = cur?.latestRevisionId || cur?.revisionId || null; } catch {}
    await pc("PUT", `/api/issues/${issue.id}/documents/latest`, { title: "Latest hygiene report", format: "markdown", body: md, ...(base ? { baseRevisionId: base } : {}) });
  }
  console.log(`hygiene: ${headline}`);
  if (crit) process.exitCode = 0; // report is the deliverable; do not fail the run
}

main().catch((e) => {
  console.error(e);
  try { fs.appendFileSync(new URL("./last-error.log", import.meta.url), `${new Date().toISOString()} ${e.stack || e}\n`); } catch {}
  process.exit(1);
});
