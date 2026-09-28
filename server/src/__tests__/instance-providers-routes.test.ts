import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";
import { instanceProvidersService, parseEffort } from "../services/instance-providers.js";

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    heartbeatService: () => ({}),
    instanceSettingsService: () => ({}),
    logActivity: vi.fn(),
    publishActivity: vi.fn(),
  }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => ({}) }));
  vi.doMock("../services/instance-build.js", () => ({
    instanceBuildInfo: () => ({ commit: "82744b47", shortCommit: "82744b47", build: "22", repositoryUrl: null, commits: [] }),
  }));
}

const admin = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: true, companyIds: ["c"] };
const member = { type: "board", userId: "user-2", source: "session", isInstanceAdmin: false, companyIds: ["c"] };

const LATEST: Record<string, string> = {
  "@anthropic-ai/claude-agent-sdk": "0.3.283",
  "@anthropic-ai/claude-code": "2.1.283",
  "@agentclientprotocol/claude-agent-acp": "0.81.2",
};

describe("instance providers routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
    ]);
    return { errorHandler, instanceSettingsRoutes };
  });

  let dir: string;
  let pkgDir: string;
  let effortDropin: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grappus-providers-"));
    pkgDir = mkdtempSync(join(tmpdir(), "grappus-pkgs-"));
    effortDropin = join(pkgDir, "50-paperclip-effort.json");
    writeFileSync(join(pkgDir, "sdk.json"), JSON.stringify({ version: "0.3.263", claudeCodeVersion: "2.1.263" }));
    writeFileSync(join(pkgDir, "acp.json"), JSON.stringify({ version: "0.73.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  });

  function createApp(actor: any) {
    const { errorHandler, instanceSettingsRoutes } = routeModules.value;
    const providers = instanceProvidersService({
      dir,
      effortDropin,
      fetchImpl: (async (url: string) => {
        const pkg = decodeURIComponent(String(url).replace("https://registry.npmjs.org/", "").replace(/\/latest$/, ""));
        return new Response(JSON.stringify({ version: LATEST[pkg] }), { status: 200 });
      }) as any,
      packageJson: (pkg) =>
        pkg === "@anthropic-ai/claude-agent-sdk" ? join(pkgDir, "sdk.json")
        : pkg === "@agentclientprotocol/claude-agent-acp" ? join(pkgDir, "acp.json")
        : null,
      hostCliVersion: async () => "2.1.281",
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", instanceSettingsRoutes({} as any, { updates: null, providers }));
    app.use(errorHandler);
    return app;
  }

  it("reports agent runtime, host CLI and effort versus npm", async () => {
    writeFileSync(effortDropin, JSON.stringify({ effortLevel: "low" }));
    const res = await request(createApp(member)).get("/api/instance/providers");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      canManage: false,
      agentRuntime: {
        sdk: { installed: "0.3.263", latest: "0.3.283" },
        claudeCode: { installed: "2.1.263", latest: "2.1.283" },
        acpBridge: { installed: "0.73.0", latest: "0.81.2" },
        pinned: true,
      },
      hostCli: { installed: "2.1.281", latest: "2.1.283" },
      effort: { level: "low" },
      status: null,
    });
  });

  it("queues an effort change for the host helper (admins only)", async () => {
    const denied = await request(createApp(member)).post("/api/instance/providers/action").send({ action: "set_effort", effortLevel: "low" });
    expect(denied.status).toBe(403);
    expect(existsSync(join(dir, "request.json"))).toBe(false);

    const res = await request(createApp(admin)).post("/api/instance/providers/action").send({ action: "set_effort", effortLevel: "low" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: "queued", action: "set_effort" });
    expect(JSON.parse(readFileSync(join(dir, "request.json"), "utf8"))).toMatchObject({ action: "set_effort", effortLevel: "low", requestedBy: "user-1" });
  });

  it("rejects unknown actions and levels, and a second action while one runs", async () => {
    const app = createApp(admin);
    expect((await request(app).post("/api/instance/providers/action").send({ action: "rm_rf" })).status).toBe(422);
    expect((await request(app).post("/api/instance/providers/action").send({ action: "set_effort", effortLevel: "ultra" })).status).toBe(422);
    expect((await request(app).post("/api/instance/providers/action").send({ action: "update_claude_cli" })).status).toBe(202);
    const again = await request(app).post("/api/instance/providers/action").send({ action: "set_effort", effortLevel: "high" });
    expect(again.status).toBe(409);
    expect(JSON.parse(readFileSync(join(dir, "request.json"), "utf8")).action).toBe("update_claude_cli");
  });

  it("treats a missing or unknown drop-in as Claude Code's default effort", () => {
    expect(parseEffort(null)).toBe("default");
    expect(parseEffort({ effortLevel: "ultra" })).toBe("default");
    expect(parseEffort({ effortLevel: "xhigh" })).toBe("xhigh");
  });
});
