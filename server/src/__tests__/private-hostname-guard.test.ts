import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  hostnameMatchesAllowed,
  privateHostnameGuard,
} from "../middleware/private-hostname-guard.js";

const unknownHostname = "blocked-host.invalid";

function createApp(opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string }) {
  const app = express();
  app.use(
    privateHostnameGuard({
      enabled: opts.enabled,
      allowedHostnames: opts.allowedHostnames ?? [],
      bindHost: opts.bindHost ?? "0.0.0.0",
    }),
  );
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/dashboard", (_req, res) => {
    res.status(200).send("ok");
  });
  return app;
}

describe("privateHostnameGuard", () => {
  it("allows requests when disabled", async () => {
    const app = createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "localhost:3100");
    expect(res.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with a static remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", `${unknownHostname}:3100`);
    expect(res.status).toBe(403);
    // The remediation command carries a static `<host>` placeholder. It never
    // interpolates the request Host header into the command.
    expect(res.body?.error).toContain("run npx paperclipai allowed-hostname <host>");
    expect(res.body?.error).not.toContain(unknownHostname);
  });

  it("blocks unknown hostnames on page routes with a static plain-text remediation command", async () => {
    const middleware = privateHostnameGuard({
      enabled: true,
      allowedHostnames: ["some-other-host"],
      bindHost: "0.0.0.0",
    });
    const req = {
      path: "/dashboard",
      header: (name: string) => (name.toLowerCase() === "host" ? `${unknownHostname}:3100` : undefined),
      accepts: () => "html",
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("run npx paperclipai allowed-hostname <host>"),
    );
    expect(res.send).not.toHaveBeenCalledWith(expect.stringContaining(unknownHostname));
  }, 20_000);

  it("does not reflect a hostile Host header into the remediation command", async () => {
    // An unauthenticated requester can send an invalid Host header that holds
    // shell metacharacters. `extractHostname` falls back to the raw header when
    // URL parsing fails. The 403 guidance must not echo that value, so an
    // operator or an agent cannot paste an attacker-controlled span into a
    // shell. Use a harmless, nonexistent command name inside the span.
    const hostileHost = "evil$(echo marker)host";
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", hostileHost);
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("run npx paperclipai allowed-hostname <host>");
    expect(res.body?.error).not.toContain("evil");
    expect(res.body?.error).not.toContain("$(");
    expect(res.body?.error).not.toContain("marker");
  });
});

describe("hostnameMatchesAllowed (wildcard support)", () => {
  it("matches an exact hostname even when wildcards are present elsewhere in the list", () => {
    expect(
      hostnameMatchesAllowed("board.example.test", [
        "board.example.test",
        "*.187-126-114-172.sslip.io",
      ]),
    ).toBe(true);
  });

  it("matches a hostname against a leftmost-label wildcard", () => {
    expect(
      hostnameMatchesAllowed("gra-632.187-126-114-172.sslip.io", [
        "*.187-126-114-172.sslip.io",
      ]),
    ).toBe(true);
    expect(
      hostnameMatchesAllowed("gra-633.187-126-114-172.sslip.io", [
        "*.187-126-114-172.sslip.io",
      ]),
    ).toBe(true);
  });

  it("does not match the bare base hostname against a leftmost-label wildcard", () => {
    // *.187-126-114-172.sslip.io requires at least one character before the
    // dot, so the bare production hostname stays governed by its explicit
    // entry and not by the wildcard alone.
    expect(
      hostnameMatchesAllowed("187-126-114-172.sslip.io", [
        "*.187-126-114-172.sslip.io",
      ]),
    ).toBe(false);
  });

  it("does not let a wildcard match across unrelated base domains", () => {
    expect(
      hostnameMatchesAllowed("evil.example.attacker.tld", [
        "*.example.com",
      ]),
    ).toBe(false);
    expect(
      hostnameMatchesAllowed("example.com.attacker.tld", [
        "*.example.com",
      ]),
    ).toBe(false);
  });

  it("matches a hostname against a single-character `?` wildcard", () => {
    expect(
      hostnameMatchesAllowed("ab.example.test", [
        "a?.example.test",
      ]),
    ).toBe(true);
    expect(
      hostnameMatchesAllowed("a.example.test", [
        "a?.example.test",
      ]),
    ).toBe(false);
    expect(
      hostnameMatchesAllowed("abc.example.test", [
        "a?.example.test",
      ]),
    ).toBe(false);
  });

  it("treats each pattern independently", () => {
    expect(
      hostnameMatchesAllowed("gra-632.187-126-114-172.sslip.io", [
        "187.126.114.172.sslip.io",
        "*.187-126-114-172.sslip.io",
      ]),
    ).toBe(true);
    expect(
      hostnameMatchesAllowed("unrelated.example.test", [
        "187.126.114.172.sslip.io",
        "*.187-126-114-172.sslip.io",
      ]),
    ).toBe(false);
  });

  it("skips empty patterns", () => {
    expect(
      hostnameMatchesAllowed("board.example.test", [
        "",
        "  ",
        "board.example.test",
      ]),
    ).toBe(true);
  });
});

describe("privateHostnameGuard (wildcard end-to-end)", () => {
  it("allows a preview subdomain against a wildcard pattern in PAPERCLIP_ALLOWED_HOSTNAMES", async () => {
    // GRA-632 / GRA-633 reproduce: preview hostnames are slug-shaped subdomains
    // of 187-126-114-172.sslip.io. Operators want one env entry to cover them
    // all instead of listing every preview slug as it is created.
    const app = createApp({
      enabled: true,
      allowedHostnames: [
        "187.126.114.172.sslip.io",
        "*.187-126-114-172.sslip.io",
      ],
    });
    const res = await request(app).get("/api/health").set("Host", "gra-632.187-126-114-172.sslip.io");
    expect(res.status).toBe(200);
  });

  it("still blocks hostnames outside the wildcard's base", async () => {
    const app = createApp({
      enabled: true,
      allowedHostnames: ["*.187-126-114-172.sslip.io"],
    });
    const res = await request(app).get("/api/health").set("Host", "evil.example.attacker.tld");
    expect(res.status).toBe(403);
    expect(res.body?.error).not.toContain("evil.example.attacker.tld");
  });
});
