import { execFile } from "node:child_process";
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
