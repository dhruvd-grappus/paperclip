import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  companies,
  agents,
  costEvents,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { foldTokenUsageWindow, statsService } from "../services/stats.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const OVERVIEW_FIXTURE = {
  range: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z" },
  timeBurn: { totalMs: 0, avgMsPerDay: 0, previousAvgMsPerDay: 0, days: [] },
  parentTasks: { doneCount: 0, avgDurationMs: 0, medianDurationMs: 0, notMeasurableCount: 0 },
  fastestTask: null,
  slowestTask: null,
  throughput: { donePerDay: [], wipCount: 0, blockedCount: 0 },
};

const mockStatsService = vi.hoisted(() => ({
  overview: vi.fn(),
  byProject: vi.fn(),
  tokenUsage: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    statsService: () => mockStatsService,
    accessService: () => mockAccessService,
  }));
}

describe("stats routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [statsRouteModule, middlewareModule] = await Promise.all([
      vi.importActual<typeof import("../routes/stats.js")>("../routes/stats.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { ...statsRouteModule, errorHandler: middlewareModule.errorHandler };
  });

  function createApp(actor: any = { type: "board", userId: "board-user", source: "local_implicit" }) {
    const { statsRoutes, errorHandler } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", statsRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockStatsService.overview.mockResolvedValue(OVERVIEW_FIXTURE);
    mockStatsService.byProject.mockResolvedValue({ projects: [] });
  });

  it("serves the overview and passes the parsed range and project through", async () => {
    const projectId = randomUUID();
    const res = await request(createApp()).get(
      `/api/companies/company-1/stats/overview?from=2026-03-01T00:00:00.000Z&to=2026-03-31T23:59:59.999Z&projectId=${projectId}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(OVERVIEW_FIXTURE);
    expect(mockStatsService.overview).toHaveBeenCalledWith("company-1", {
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-31T23:59:59.999Z"),
      projectId,
    });
  });

  it("serves the project table without a range", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/stats/by-project");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projects: [] });
    expect(mockStatsService.byProject).toHaveBeenCalledWith("company-1", {
      from: undefined,
      to: undefined,
      projectId: undefined,
    });
  });

  it("serves token usage by account for the company", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    const payload = { generatedAt: "2026-09-29T12:00:00.000Z", activeAccountLabel: "a@b.c", windows: [] };
    mockStatsService.tokenUsage.mockResolvedValue(payload);
    const res = await request(createApp()).get("/api/companies/company-1/stats/token-usage");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(mockStatsService.tokenUsage).toHaveBeenCalledWith("company-1");
  });

  it("rejects an unparsable range", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/stats/overview?from=yesterday");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'from'");
    expect(mockStatsService.overview).not.toHaveBeenCalled();
  });

  it("refuses a caller outside the company scope boundary", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "company_scope:read",
      reason: "deny_test",
      explanation: "Denied by test mock.",
    });

    const res = await request(createApp()).get("/api/companies/company-1/stats/overview");

    expect(res.status).toBe(403);
    expect(mockStatsService.overview).not.toHaveBeenCalled();
  });

  it("refuses an agent key pointed at another company", async () => {
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-2" });
    const res = await request(app).get("/api/companies/company-1/stats/by-project");

    expect(res.status).toBe(403);
    expect(mockStatsService.byProject).not.toHaveBeenCalled();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("foldTokenUsageWindow", () => {
  const row = (accountLabel: string | null, agentId: string, input: number, output: number, cached = 0, runs = 1) => ({
    accountLabel,
    provider: "anthropic",
    agentId,
    agentName: `Agent ${agentId}`,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    costCents: 0,
    runCount: runs,
  });

  it("totals per account, per agent inside each account, and per agent overall, largest first", () => {
    const since = new Date("2026-09-22T00:00:00.000Z");
    const window = foldTokenUsageWindow("7d", 168, since, [
      row("levelup@grappus.com", "a1", 100, 10, 5, 2),
      row("levelup@grappus.com", "a2", 300, 30, 0, 1),
      row("minion@unberry.com", "a1", 50, 5, 0, 1),
      row(null, "a3", 1, 1, 0, 1),
    ]);
    expect(window.since).toBe(since.toISOString());
    expect(window.totals).toEqual({ inputTokens: 451, cachedInputTokens: 5, outputTokens: 46, totalTokens: 502, costCents: 0, runCount: 5 });
    expect(window.accounts.map((a) => [a.accountLabel, a.totalTokens, a.agents.map((g) => g.agentId)])).toEqual([
      ["levelup@grappus.com", 445, ["a2", "a1"]],
      ["minion@unberry.com", 55, ["a1"]],
      [null, 2, ["a3"]],
    ]);
    expect(window.agents.map((a) => [a.agentId, a.totalTokens, a.runCount])).toEqual([
      ["a2", 330, 1],
      ["a1", 170, 3],
      ["a3", 2, 1],
    ]);
  });

  it("returns empty structures for a quiet window", () => {
    const window = foldTokenUsageWindow("1d", 24, new Date(), []);
    expect(window.totals.totalTokens).toBe(0);
    expect(window.accounts).toEqual([]);
    expect(window.agents).toEqual([]);
  });
});

describeEmbeddedPostgres("stats service", () => {
  const RANGE = {
    from: new Date("2026-03-01T00:00:00.000Z"),
    to: new Date("2026-03-31T23:59:59.999Z"),
  };
  const RANGE_DAYS = 31;

  let db!: ReturnType<typeof createDb>;
  let stats!: ReturnType<typeof statsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stats-service-");
    db = createDb(tempDb.connectionString);
    stats = statsService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${name} Agent`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    let issueNumber = 0;
    return {
      companyId,
      agentId,
      async project(projectName: string) {
        const id = randomUUID();
        await db.insert(projects).values({ id, companyId, name: projectName, status: "active" });
        return id;
      },
      async issue(values: Partial<typeof issues.$inferInsert> & { title: string }) {
        issueNumber += 1;
        const id = values.id ?? randomUUID();
        await db.insert(issues).values({
          id,
          companyId,
          identifier: `${prefix}-${issueNumber}`,
          issueNumber,
          status: "done",
          ...values,
        });
        return id;
      },
      async run(values: { startedAt: Date | null; finishedAt: Date | null; issueId?: string; viaSnapshot?: boolean }) {
        const id = randomUUID();
        await db.insert(heartbeatRuns).values({
          id,
          companyId,
          agentId,
          status: values.finishedAt ? "finished" : "running",
          startedAt: values.startedAt,
          finishedAt: values.finishedAt,
          nativeIssueId: values.issueId && !values.viaSnapshot ? values.issueId : null,
          contextSnapshot: values.issueId && values.viaSnapshot ? { issueId: values.issueId } : null,
        });
        return id;
      },
      async cost(values: {
        costCents: number;
        projectId?: string;
        issueId?: string;
        occurredAt: Date;
        accountLabel?: string | null;
        inputTokens?: number;
        outputTokens?: number;
        heartbeatRunId?: string;
      }) {
        await db.insert(costEvents).values({
          companyId,
          agentId,
          projectId: values.projectId ?? null,
          issueId: values.issueId ?? null,
          heartbeatRunId: values.heartbeatRunId ?? null,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "metered_api",
          model: "claude-opus-5",
          accountLabel: values.accountLabel ?? null,
          inputTokens: values.inputTokens ?? 0,
          cachedInputTokens: 0,
          outputTokens: values.outputTokens ?? 0,
          costCents: values.costCents,
          occurredAt: values.occurredAt,
        });
      },
    };
  }

  it("reports burn, parent durations and extremes, ignoring children, cancelled and hidden work", async () => {
    const company = await seedCompany("Grappus");

    const parentA = await company.issue({
      title: "Two hour parent",
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      completedAt: new Date("2026-03-02T02:00:00.000Z"),
    });
    await company.issue({
      title: "Six hour parent",
      startedAt: new Date("2026-03-04T00:00:00.000Z"),
      completedAt: new Date("2026-03-04T06:00:00.000Z"),
    });
    await company.issue({
      title: "Parent with no start clock",
      startedAt: null,
      completedAt: new Date("2026-03-05T01:00:00.000Z"),
    });
    const child = await company.issue({
      title: "Half hour child",
      parentId: parentA,
      startedAt: new Date("2026-03-03T00:00:00.000Z"),
      completedAt: new Date("2026-03-03T00:30:00.000Z"),
    });
    await company.issue({
      title: "Cancelled parent",
      status: "cancelled",
      startedAt: new Date("2026-03-06T00:00:00.000Z"),
      completedAt: new Date("2026-03-06T00:01:00.000Z"),
      cancelledAt: new Date("2026-03-06T00:01:00.000Z"),
    });
    await company.issue({
      title: "Hidden parent",
      startedAt: new Date("2026-03-07T00:00:00.000Z"),
      completedAt: new Date("2026-03-07T00:02:00.000Z"),
      hiddenAt: new Date("2026-03-07T00:03:00.000Z"),
    });
    await company.issue({
      title: "Parent done before the range",
      startedAt: new Date("2026-02-15T00:00:00.000Z"),
      completedAt: new Date("2026-02-15T10:00:00.000Z"),
    });
    await company.issue({ title: "Running parent", status: "in_progress" });
    await company.issue({ title: "Reviewing parent", status: "in_review" });
    await company.issue({ title: "Blocked parent", status: "blocked" });
    await company.issue({ title: "Running child", status: "in_progress", parentId: parentA });

    await company.run({
      startedAt: new Date("2026-03-02T04:00:00.000Z"),
      finishedAt: new Date("2026-03-02T05:00:00.000Z"),
    });
    await company.run({
      startedAt: new Date("2026-03-02T08:30:00.000Z"),
      finishedAt: new Date("2026-03-02T09:00:00.000Z"),
    });
    await company.run({
      startedAt: new Date("2026-03-10T09:00:00.000Z"),
      finishedAt: new Date("2026-03-10T10:00:00.000Z"),
    });
    await company.run({ startedAt: new Date("2026-03-11T09:00:00.000Z"), finishedAt: null });
    await company.run({
      startedAt: new Date("2026-02-19T22:00:00.000Z"),
      finishedAt: new Date("2026-02-20T00:00:00.000Z"),
    });

    const overview = await stats.overview(company.companyId, RANGE);

    expect(overview.range).toEqual({ from: RANGE.from.toISOString(), to: RANGE.to.toISOString() });
    expect(overview.parentTasks).toEqual({
      doneCount: 3,
      avgDurationMs: 14_400_000,
      medianDurationMs: 14_400_000,
      notMeasurableCount: 1,
    });
    expect(overview.fastestTask).toMatchObject({ issueId: child, durationMs: 1_800_000 });
    expect(overview.slowestTask).toMatchObject({ title: "Six hour parent", durationMs: 21_600_000 });

    expect(overview.timeBurn.totalMs).toBe(9_000_000);
    expect(overview.timeBurn.avgMsPerDay).toBe(Math.round(9_000_000 / RANGE_DAYS));
    expect(overview.timeBurn.previousAvgMsPerDay).toBe(Math.round(7_200_000 / RANGE_DAYS));
    expect(overview.timeBurn.days).toHaveLength(RANGE_DAYS);
    expect(overview.timeBurn.days[1]).toEqual({ date: "2026-03-02", ms: 5_400_000, runCount: 2 });
    expect(overview.timeBurn.days[9]).toEqual({ date: "2026-03-10", ms: 3_600_000, runCount: 1 });

    expect(overview.throughput.donePerDay).toHaveLength(RANGE_DAYS);
    expect(overview.throughput.donePerDay.reduce((sum, day) => sum + day.count, 0)).toBe(3);
    expect(overview.throughput.donePerDay[1]).toEqual({ date: "2026-03-02", count: 1 });
    expect(overview.throughput.wipCount).toBe(2);
    expect(overview.throughput.blockedCount).toBe(1);
  });

  it("returns zeros and null extremes for a range with no work", async () => {
    const company = await seedCompany("Quiet");
    await company.issue({
      title: "Done in March",
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      completedAt: new Date("2026-03-02T02:00:00.000Z"),
    });

    const overview = await stats.overview(company.companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-03T23:59:59.999Z"),
    });

    expect(overview.parentTasks).toEqual({
      doneCount: 0,
      avgDurationMs: 0,
      medianDurationMs: 0,
      notMeasurableCount: 0,
    });
    expect(overview.fastestTask).toBeNull();
    expect(overview.slowestTask).toBeNull();
    expect(overview.timeBurn.totalMs).toBe(0);
    expect(overview.timeBurn.avgMsPerDay).toBe(0);
    expect(overview.timeBurn.days).toEqual([
      { date: "2026-04-01", ms: 0, runCount: 0 },
      { date: "2026-04-02", ms: 0, runCount: 0 },
      { date: "2026-04-03", ms: 0, runCount: 0 },
    ]);
    expect(overview.throughput.donePerDay.every((day) => day.count === 0)).toBe(true);
  });

  it("splits token usage by cloud account and agent over rolling windows", async () => {
    const now = new Date("2026-09-29T12:00:00.000Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
    const company = await seedCompany("Tokens");
    const other = await seedCompany("Elsewhere");
    const runA = await company.run({ startedAt: hoursAgo(2), finishedAt: hoursAgo(1) });
    const runB = await company.run({ startedAt: hoursAgo(50), finishedAt: hoursAgo(49) });
    await company.cost({ costCents: 0, occurredAt: hoursAgo(1), accountLabel: "levelup@grappus.com", inputTokens: 100, outputTokens: 10, heartbeatRunId: runA });
    await company.cost({ costCents: 0, occurredAt: hoursAgo(49), accountLabel: "minion@unberry.com", inputTokens: 200, outputTokens: 20, heartbeatRunId: runB });
    await company.cost({ costCents: 0, occurredAt: hoursAgo(24 * 10), accountLabel: null, inputTokens: 1000, outputTokens: 100 });
    await company.cost({ costCents: 0, occurredAt: hoursAgo(24 * 40), accountLabel: "levelup@grappus.com", inputTokens: 5000, outputTokens: 500 });
    await other.cost({ costCents: 0, occurredAt: hoursAgo(1), accountLabel: "levelup@grappus.com", inputTokens: 7, outputTokens: 7 });

    const usage = await stats.tokenUsage(company.companyId, now);
    expect(usage.windows.map((w) => w.window)).toEqual(["1d", "5d", "7d", "30d"]);
    const byWindow = Object.fromEntries(usage.windows.map((w) => [w.window, w]));

    expect(byWindow["1d"]!.totals.totalTokens).toBe(110);
    expect(byWindow["1d"]!.accounts.map((a) => [a.accountLabel, a.totalTokens, a.runCount])).toEqual([["levelup@grappus.com", 110, 1]]);
    expect(byWindow["1d"]!.accounts[0]!.agents[0]).toMatchObject({ agentId: company.agentId, agentName: "Tokens Agent", totalTokens: 110 });

    expect(byWindow["5d"]!.totals.totalTokens).toBe(330);
    expect(byWindow["5d"]!.accounts.map((a) => [a.accountLabel, a.totalTokens])).toEqual([
      ["minion@unberry.com", 220],
      ["levelup@grappus.com", 110],
    ]);
    expect(byWindow["5d"]!.agents).toHaveLength(1);
    expect(byWindow["5d"]!.agents[0]!.runCount).toBe(2);

    expect(byWindow["30d"]!.totals.totalTokens).toBe(1430);
    expect(byWindow["30d"]!.accounts.map((a) => a.accountLabel)).toEqual([null, "minion@unberry.com", "levelup@grappus.com"]);
  });

  it("keeps one company's numbers out of another's", async () => {
    const ours = await seedCompany("Ours");
    const theirs = await seedCompany("Theirs");
    const ourProject = await ours.project("Ours Project");
    const theirProject = await theirs.project("Theirs Project");

    await ours.issue({
      title: "Our parent",
      projectId: ourProject,
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      completedAt: new Date("2026-03-02T01:00:00.000Z"),
    });
    await ours.run({
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      finishedAt: new Date("2026-03-02T01:00:00.000Z"),
    });
    await ours.cost({ costCents: 500, projectId: ourProject, occurredAt: new Date("2026-03-02T01:00:00.000Z") });

    for (const day of ["03", "04", "05"]) {
      await theirs.issue({
        title: `Their parent ${day}`,
        projectId: theirProject,
        startedAt: new Date(`2026-03-${day}T00:00:00.000Z`),
        completedAt: new Date(`2026-03-${day}T05:00:00.000Z`),
      });
    }
    await theirs.run({
      startedAt: new Date("2026-03-03T00:00:00.000Z"),
      finishedAt: new Date("2026-03-03T05:00:00.000Z"),
    });
    await theirs.cost({ costCents: 9_000, projectId: theirProject, occurredAt: new Date("2026-03-03T05:00:00.000Z") });

    const overview = await stats.overview(ours.companyId, RANGE);
    const byProject = await stats.byProject(ours.companyId, RANGE);

    expect(overview.parentTasks.doneCount).toBe(1);
    expect(overview.timeBurn.totalMs).toBe(3_600_000);
    expect(byProject.projects).toHaveLength(1);
    expect(byProject.projects[0]).toMatchObject({ projectId: ourProject, spendCents: 500 });
  });

  it("scores each project on delivery, agent time and spend", async () => {
    const company = await seedCompany("Portfolio");
    const fast = await company.project("Fast");
    const spendOnly = await company.project("Spend only");
    await company.project("Untouched");

    const oneHour = await company.issue({
      title: "One hour",
      projectId: fast,
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      completedAt: new Date("2026-03-02T01:00:00.000Z"),
    });
    await company.issue({
      title: "Three hours",
      projectId: fast,
      startedAt: new Date("2026-03-03T00:00:00.000Z"),
      completedAt: new Date("2026-03-03T03:00:00.000Z"),
    });

    await company.run({
      issueId: oneHour,
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      finishedAt: new Date("2026-03-02T01:00:00.000Z"),
    });
    await company.run({
      issueId: oneHour,
      viaSnapshot: true,
      startedAt: new Date("2026-03-02T02:00:00.000Z"),
      finishedAt: new Date("2026-03-02T02:30:00.000Z"),
    });

    await company.cost({ costCents: 400, projectId: fast, occurredAt: new Date("2026-03-02T01:00:00.000Z") });
    await company.cost({ costCents: 200, issueId: oneHour, occurredAt: new Date("2026-03-02T01:30:00.000Z") });
    await company.cost({ costCents: 100, projectId: spendOnly, occurredAt: new Date("2026-03-04T01:00:00.000Z") });

    const { projects: rows } = await stats.byProject(company.companyId, RANGE);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      projectId: fast,
      name: "Fast",
      doneCount: 2,
      avgDurationMs: 7_200_000,
      medianDurationMs: 7_200_000,
      timeSpentMs: 5_400_000,
      spendCents: 600,
      costPerDoneTaskCents: 300,
    });
    expect(rows[1]).toEqual({
      projectId: spendOnly,
      name: "Spend only",
      doneCount: 0,
      avgDurationMs: 0,
      medianDurationMs: 0,
      timeSpentMs: 0,
      spendCents: 100,
      costPerDoneTaskCents: 0,
    });
  });

  it("narrows the overview to one project, agent time included", async () => {
    const company = await seedCompany("Filtered");
    const mine = await company.project("Mine");
    const other = await company.project("Other");

    const mineIssue = await company.issue({
      title: "Mine",
      projectId: mine,
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      completedAt: new Date("2026-03-02T01:00:00.000Z"),
    });
    const otherIssue = await company.issue({
      title: "Other",
      projectId: other,
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      completedAt: new Date("2026-03-02T04:00:00.000Z"),
    });
    await company.run({
      issueId: mineIssue,
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      finishedAt: new Date("2026-03-02T01:00:00.000Z"),
    });
    await company.run({
      issueId: otherIssue,
      startedAt: new Date("2026-03-02T00:00:00.000Z"),
      finishedAt: new Date("2026-03-02T04:00:00.000Z"),
    });

    const overview = await stats.overview(company.companyId, { ...RANGE, projectId: mine });

    expect(overview.parentTasks.doneCount).toBe(1);
    expect(overview.slowestTask).toMatchObject({ issueId: mineIssue, durationMs: 3_600_000 });
    expect(overview.timeBurn.totalMs).toBe(3_600_000);
    expect(overview.throughput.wipCount).toBe(0);
  });
});
