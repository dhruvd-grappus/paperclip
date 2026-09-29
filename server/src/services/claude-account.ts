import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The Claude account the server's own login uses (what agent runs inherit). */
export interface ClaudeAccount {
  email: string | null;
  plan: string | null;
  orgName: string | null;
}

export function parseClaudeAuthStatus(stdout: string): ClaudeAccount | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  if (row.loggedIn !== true) return null;
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  const account = { email: str(row.email), plan: str(row.subscriptionType), orgName: str(row.orgName) };
  return account.email || account.plan ? account : null;
}

const CACHE_MS = 60_000;
let cache: { at: number; account: ClaudeAccount | null } | null = null;

/**
 * `claude auth status` for the server user, cached for a minute. The login can
 * rotate between accounts (claude-swap on the host), so it is re-read rather
 * than remembered. Null when the CLI is missing, logged out, or slow.
 */
export async function readClaudeAccount(
  run: () => Promise<string> = async () =>
    (await execFileAsync("claude", ["auth", "status"], { env: process.env, timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout,
  now: () => number = Date.now,
): Promise<ClaudeAccount | null> {
  if (cache && now() - cache.at < CACHE_MS) return cache.account;
  let account: ClaudeAccount | null = null;
  try {
    account = parseClaudeAuthStatus(await run());
  } catch {
    account = null;
  }
  cache = { at: now(), account };
  return account;
}

export function resetClaudeAccountCacheForTests() {
  cache = null;
}

/**
 * Email of the login in Claude Code's global config (`oauthAccount.emailAddress`
 * in `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`). This is the file
 * claude-swap rewrites on every rotation, so it names the account an agent run
 * inherits without spawning the CLI.
 */
export function parseClaudeConfigAccountLabel(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const account = (parsed as Record<string, unknown>).oauthAccount;
  if (!account || typeof account !== "object") return null;
  const email = (account as Record<string, unknown>).emailAddress;
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
}

export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR?.trim() || env.HOME?.trim() || os.homedir();
  return path.join(base, ".claude.json");
}

const LABEL_CACHE_MS = 15_000;
let labelCache: { at: number; label: string | null } | null = null;

/**
 * The account label to stamp on a cost event. Reads the config file (cached for
 * 15s so a burst of run completions costs one read) and falls back to
 * `claude auth status` when the file has no login.
 */
export async function readActiveClaudeAccountLabel(
  read: () => Promise<string> = () => readFile(claudeConfigPath(), "utf8"),
  now: () => number = Date.now,
): Promise<string | null> {
  if (labelCache && now() - labelCache.at < LABEL_CACHE_MS) return labelCache.label;
  let label: string | null = null;
  try {
    label = parseClaudeConfigAccountLabel(await read());
  } catch {
    label = null;
  }
  if (!label) {
    const account = await readClaudeAccount();
    label = account?.email ? account.email.trim().toLowerCase() : null;
  }
  labelCache = { at: now(), label };
  return label;
}

export function resetClaudeAccountLabelCacheForTests() {
  labelCache = null;
}
