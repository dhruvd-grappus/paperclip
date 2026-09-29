import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeConfigPath,
  parseClaudeAuthStatus,
  parseClaudeConfigAccountLabel,
  readActiveClaudeAccountLabel,
  readClaudeAccount,
  resetClaudeAccountCacheForTests,
  resetClaudeAccountLabelCacheForTests,
} from "./claude-account.js";

const STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "ankitseniaray01@gmail.com",
  orgName: "ankitseniaray01@gmail.com's Organization",
  subscriptionType: "max",
});

afterEach(() => {
  resetClaudeAccountCacheForTests();
  resetClaudeAccountLabelCacheForTests();
});

describe("claude account", () => {
  it("reads email, plan and org from `claude auth status`", () => {
    expect(parseClaudeAuthStatus(STATUS)).toEqual({
      email: "ankitseniaray01@gmail.com",
      plan: "max",
      orgName: "ankitseniaray01@gmail.com's Organization",
    });
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false, email: "x@y" }))).toBeNull();
    expect(parseClaudeAuthStatus("not json")).toBeNull();
  });

  it("caches for a minute and re-reads after, so a rotated login shows up", async () => {
    let now = 0;
    const run = vi.fn()
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce(STATUS.replace("ankitseniaray01@gmail.com\"", "levelup@grappus.com\""));
    await expect(readClaudeAccount(run, () => now)).resolves.toMatchObject({ email: "ankitseniaray01@gmail.com" });
    now = 30_000;
    await readClaudeAccount(run, () => now);
    expect(run).toHaveBeenCalledTimes(1);
    now = 61_000;
    await expect(readClaudeAccount(run, () => now)).resolves.toMatchObject({ email: "levelup@grappus.com" });
  });

  it("returns null when the CLI fails", async () => {
    await expect(readClaudeAccount(async () => { throw new Error("ENOENT"); })).resolves.toBeNull();
  });
});

describe("active claude account label", () => {
  const CONFIG = JSON.stringify({ oauthAccount: { emailAddress: "LevelUp@grappus.com", organizationName: "x" } });

  it("takes the login email from .claude.json, lower-cased", () => {
    expect(parseClaudeConfigAccountLabel(CONFIG)).toBe("levelup@grappus.com");
    expect(parseClaudeConfigAccountLabel(JSON.stringify({ oauthAccount: {} }))).toBeNull();
    expect(parseClaudeConfigAccountLabel(JSON.stringify({}))).toBeNull();
    expect(parseClaudeConfigAccountLabel("{")).toBeNull();
  });

  it("prefers CLAUDE_CONFIG_DIR over HOME for the config file", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/srv/cc", HOME: "/home/x" })).toBe("/srv/cc/.claude.json");
    expect(claudeConfigPath({ HOME: "/home/x" })).toBe("/home/x/.claude.json");
  });

  it("caches for 15s and picks up a claude-swap rotation after", async () => {
    let now = 1_000_000;
    const read = vi.fn().mockResolvedValue(CONFIG);
    expect(await readActiveClaudeAccountLabel(read, () => now)).toBe("levelup@grappus.com");
    read.mockResolvedValue(JSON.stringify({ oauthAccount: { emailAddress: "minion@unberry.com" } }));
    now += 5_000;
    expect(await readActiveClaudeAccountLabel(read, () => now)).toBe("levelup@grappus.com");
    now += 15_000;
    expect(await readActiveClaudeAccountLabel(read, () => now)).toBe("minion@unberry.com");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns null when the config is unreadable and the CLI is logged out", async () => {
    const read = vi.fn().mockRejectedValue(new Error("ENOENT"));
    // readClaudeAccount is called with its defaults here; force its cache to a logged-out answer first.
    await readClaudeAccount(async () => JSON.stringify({ loggedIn: false }));
    expect(await readActiveClaudeAccountLabel(read)).toBeNull();
  });
});
