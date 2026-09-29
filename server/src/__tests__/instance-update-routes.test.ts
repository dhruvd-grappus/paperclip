import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";
import { instanceAutoUpdater, instanceUpdateService, parseRelease } from "../services/instance-update.js";

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    heartbeatService: () => ({}),
    instanceSettingsService: () => ({}),
    logActivity: vi.fn(),
    publishActivity: vi.fn(),
  }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => ({}) }));
  vi.doMock("../services/instance-build.js", () => ({
    instanceBuildInfo: () => ({
      commit: "82744b4733ea0000000000000000000000000000",
      shortCommit: "82744b473",
      build: "3",
      repositoryUrl: "https://github.com/dhruvd-grappus/paperclip",
      commits: [],
    }),
  }));
}

const LATEST = {
  tag_name: "overlay-2138d93848bd",
  name: "2026.916.1-grappus.5 (2138d93848bd)",
  body: "## Changes since v2026.916.1\n- ci(grappus): build workspace dependencies",
  published_at: "2026-09-27T10:40:00Z",
  html_url: "https://github.com/dhruvd-grappus/paperclip/releases/tag/overlay-2138d93848bd",
  draft: false,
  prerelease: false,
  assets: [{ name: "paperclip-overlay.tgz" }, { name: "paperclip-overlay.tgz.sha256" }],
};

const admin = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: true, companyIds: ["c"] };
const member = { type: "board", userId: "user-2", source: "session", isInstanceAdmin: false, companyIds: ["c"] };

describe("instance self-update routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
    ]);
    return { errorHandler, instanceSettingsRoutes };
  });

  let dir: string;
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grappus-update-"));
    fetchImpl = vi.fn(async () => new Response(JSON.stringify(LATEST), { status: 200 }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function createApp(actor: any) {
    const { errorHandler, instanceSettingsRoutes } = routeModules.value;
    const updates = instanceUpdateService({ repo: "dhruvd-grappus/paperclip", dir, fetchImpl: fetchImpl as any });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", instanceSettingsRoutes({} as any, { updates }));
    app.use(errorHandler);
    return app;
  }

  it("reports the latest CI release and whether this instance runs it", async () => {
    const res = await request(createApp(member)).get("/api/instance/build/update");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      canUpdate: false,
      updateAvailable: true,
      latest: { tag: "overlay-2138d93848bd", sha: "2138d93848bd", build: "5" },
      status: null,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/dhruvd-grappus/paperclip/releases/latest",
      expect.anything(),
    );
  });

  it("lets only instance admins queue an update, and only for the latest build", async () => {
    await request(createApp(member)).post("/api/instance/build/update").send({ tag: LATEST.tag_name }).expect(403);
    expect(existsSync(join(dir, "request.json"))).toBe(false);

    const stale = await request(createApp(admin)).post("/api/instance/build/update").send({ tag: "overlay-82744b4733ea" });
    expect(stale.status).toBe(422);
    const bogus = await request(createApp(admin)).post("/api/instance/build/update").send({ tag: "../../etc" });
    expect(bogus.status).toBe(422);
    expect(existsSync(join(dir, "request.json"))).toBe(false);

    const queued = await request(createApp(admin)).post("/api/instance/build/update").send({ tag: LATEST.tag_name });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ state: "queued", tag: LATEST.tag_name });
    expect(JSON.parse(readFileSync(join(dir, "request.json"), "utf8"))).toMatchObject({
      tag: LATEST.tag_name,
      requestedBy: "user-1",
    });
  });

  it("refuses a second request while one is in flight, but not after it went stale", async () => {
    const app = createApp(admin);
    await request(app).post("/api/instance/build/update").send({ tag: LATEST.tag_name }).expect(202);
    await request(app).post("/api/instance/build/update").send({ tag: LATEST.tag_name }).expect(409);

    writeFileSync(join(dir, "status.json"), JSON.stringify({
      state: "waiting_idle", tag: LATEST.tag_name, message: "", updatedAt: "2026-01-01T00:00:00Z",
    }));
    await request(app).post("/api/instance/build/update").send({ tag: LATEST.tag_name }).expect(202);
  });

  it("surfaces GitHub being unreachable without failing the request", async () => {
    fetchImpl.mockResolvedValue(new Response("upstream exploded", { status: 500 }));
    const res = await request(createApp(member)).get("/api/instance/build/update");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, latest: null, updateAvailable: false, error: "GitHub answered 500" });
  });

  it("authenticates GitHub release checks when a token is configured", async () => {
    const authed = vi.fn(async () => new Response(JSON.stringify(LATEST), { status: 200 }));
    const svc = instanceUpdateService({
      repo: "dhruvd-grappus/paperclip", dir, fetchImpl: authed as any, token: "ghp_test",
    });
    await svc.latestRelease(true);
    expect(authed).toHaveBeenCalledWith(
      expect.stringContaining("/releases/latest"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer ghp_test" }) }),
    );
  });

  it("reads the GitHub token from the environment when no token is passed", async () => {
    process.env.PAPERCLIP_GRAPPUS_GITHUB_TOKEN = "ghp_env";
    try {
      const authed = vi.fn(async () => new Response(JSON.stringify(LATEST), { status: 200 }));
      const svc = instanceUpdateService({ repo: "dhruvd-grappus/paperclip", dir, fetchImpl: authed as any });
      await svc.latestRelease(true);
      expect(authed).toHaveBeenCalledWith(
        expect.stringContaining("/releases/latest"),
        expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer ghp_env" }) }),
      );
    } finally {
      delete process.env.PAPERCLIP_GRAPPUS_GITHUB_TOKEN;
    }
  });

  it("names the rate-limit reset instead of a bare 403", async () => {
    const reset = Math.floor(new Date("2026-09-28T11:26:34Z").getTime() / 1000);
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    }));
    const svc = instanceUpdateService({ repo: "dhruvd-grappus/paperclip", dir, fetchImpl: fetchImpl as any });
    await expect(svc.latestRelease(true)).rejects.toThrow("GitHub rate limit exceeded, retry after 11:26 UTC");
  });

  it("serves the last-known release when a refresh hits the rate limit", async () => {
    const { errorHandler, instanceSettingsRoutes } = routeModules.value;
    const updates = instanceUpdateService({ repo: "dhruvd-grappus/paperclip", dir, fetchImpl: fetchImpl as any });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = member; next(); });
    app.use("/api", instanceSettingsRoutes({} as any, { updates }));
    app.use(errorHandler);

    const ok = await request(app).get("/api/instance/build/update");
    expect(ok.body.latest?.tag).toBe("overlay-2138d93848bd");

    fetchImpl.mockResolvedValue(new Response("API rate limit exceeded", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    }));
    const limited = await request(app).get("/api/instance/build/update?refresh=1");
    expect(limited.status).toBe(200);
    expect(limited.body.latest?.tag).toBe("overlay-2138d93848bd");
    expect(limited.body.error).toMatch(/rate limit/i);
  });
  it("reports the auto-updater in GET /instance/build/update", async () => {
    const { errorHandler, instanceSettingsRoutes } = routeModules.value;
    const updates = instanceUpdateService({ repo: "dhruvd-grappus/paperclip", dir, fetchImpl: fetchImpl as any });
    const auto = instanceAutoUpdater({
      updates, currentCommit: "82744b4733ea0000000000000000000000000000", dir, enabled: true, intervalMs: 60_000,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = member; next(); });
    app.use("/api", instanceSettingsRoutes({} as any, { updates, autoUpdater: auto }));
    app.use(errorHandler);
    const res = await request(app).get("/api/instance/build/update");
    expect(res.status).toBe(200);
    expect(res.body.auto).toMatchObject({ enabled: true, active: true, intervalMs: 60_000 });
  });
});

describe("parseRelease", () => {
  it("accepts only published overlay releases that carry the tarball", () => {
    expect(parseRelease(LATEST)).toMatchObject({ tag: "overlay-2138d93848bd", build: "5" });
    expect(parseRelease({ ...LATEST, tag_name: "v2026.916.1" })).toBeNull();
    expect(parseRelease({ ...LATEST, draft: true })).toBeNull();
    expect(parseRelease({ ...LATEST, assets: [] })).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
});

describe("instanceAutoUpdater", () => {
  let dir: string;
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grappus-auto-update-"));
    fetchImpl = vi.fn(async () => new Response(JSON.stringify(LATEST), { status: 200 }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const RUNNING_OLD = "82744b4733ea0000000000000000000000000000";
  const RUNNING_LATEST = "2138d93848bd0000000000000000000000000000";

  function make(currentCommit: string | null, extra: Partial<Parameters<typeof instanceAutoUpdater>[0]> = {}) {
    const updates = instanceUpdateService({ repo: "dhruvd-grappus/paperclip", dir, fetchImpl: fetchImpl as any });
    return { updates, auto: instanceAutoUpdater({ updates, currentCommit, dir, enabled: true, intervalMs: 60_000, ...extra }) };
  }

  it("queues the latest build when it is not the running one, marked as auto-update", async () => {
    const { auto } = make(RUNNING_OLD);
    const result = await auto.tick();
    expect(result).toMatchObject({ queued: true });
    expect(JSON.parse(readFileSync(join(dir, "request.json"), "utf8"))).toMatchObject({
      tag: LATEST.tag_name,
      requestedBy: "auto-update",
    });
    expect(auto.info()).toMatchObject({ active: true, lastQueuedTag: LATEST.tag_name, lastError: null });
  });

  it("does nothing when the running build is already the latest", async () => {
    const { auto } = make(RUNNING_LATEST);
    expect(await auto.tick()).toMatchObject({ queued: false, reason: "already on the latest build" });
    expect(existsSync(join(dir, "request.json"))).toBe(false);
  });

  it("does not queue twice while an update is in flight", async () => {
    const { auto } = make(RUNNING_OLD);
    await auto.tick();
    rmSync(join(dir, "request.json"));  // the host consumed it; status.json still says queued
    expect(await auto.tick()).toMatchObject({ queued: false, reason: expect.stringContaining("in flight") });
    expect(existsSync(join(dir, "request.json"))).toBe(false);
  });

  it("never retries a build the host rolled back, but retries a plain failure after an hour", async () => {
    let clock = Date.parse("2026-09-29T10:00:00Z");
    const { auto } = make(RUNNING_OLD, { now: () => clock });
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      state: "rolled_back", tag: LATEST.tag_name, message: "verification failed", updatedAt: "2026-09-29T09:00:00Z",
    }));
    expect(await auto.tick()).toMatchObject({ queued: false, reason: expect.stringContaining("rolled back") });
    expect(existsSync(join(dir, "request.json"))).toBe(false);

    writeFileSync(join(dir, "status.json"), JSON.stringify({
      state: "failed", tag: LATEST.tag_name, message: "never went idle", updatedAt: "2026-09-29T09:30:00Z",
    }));
    expect(await auto.tick()).toMatchObject({ queued: false, reason: expect.stringContaining("retrying after") });
    clock = Date.parse("2026-09-29T10:31:00Z");
    expect(await auto.tick()).toMatchObject({ queued: true });
  });

  it("pauses while the disable file exists and stays off when disabled by env", async () => {
    const { auto } = make(RUNNING_OLD);
    writeFileSync(join(dir, "auto-update.disabled"), "");
    expect(await auto.tick()).toMatchObject({ queued: false, reason: expect.stringContaining("paused") });
    expect(auto.info()).toMatchObject({ enabled: true, active: false });
    rmSync(join(dir, "auto-update.disabled"));
    expect(await auto.tick()).toMatchObject({ queued: true });

    const off = make(RUNNING_OLD, { enabled: false });
    expect(await off.auto.tick()).toMatchObject({ queued: false, reason: expect.stringContaining("disabled") });
    expect(off.auto.info()).toMatchObject({ enabled: false, active: false });
  });

  it("records a GitHub failure and keeps going", async () => {
    fetchImpl.mockResolvedValue(new Response("nope", { status: 500 }));
    const { auto } = make(RUNNING_OLD);
    expect(await auto.tick()).toMatchObject({ queued: false, reason: expect.stringContaining("GitHub check failed") });
    expect(auto.info().lastError).toBe("GitHub answered 500");
    expect(existsSync(join(dir, "request.json"))).toBe(false);
  });
});
