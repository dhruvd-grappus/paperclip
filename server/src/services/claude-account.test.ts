import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaudeAuthStatus, readClaudeAccount, resetClaudeAccountCacheForTests } from "./claude-account.js";

const STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "ankitseniaray01@gmail.com",
  orgName: "ankitseniaray01@gmail.com's Organization",
  subscriptionType: "max",
});

afterEach(() => resetClaudeAccountCacheForTests());

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
