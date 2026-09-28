import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, companies, issueWorkProducts, issues } from "@paperclipai/db";
import type { CompletionEvidencePolicy } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue completion gate and human approval", () => {
  // Patching an issue writes an activity row and this suite seeds work
  // products, both of which reference the company, so the shared reset is not
  // enough on its own.
  const ctx = useEmbeddedPostgres("paperclip-issues-completion-gate-", {
    resetEach: async (db) => {
      await db.delete(issueWorkProducts);
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed(policy: Partial<CompletionEvidencePolicy> = {}) {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Completion gate");
    await ctx.db
      .update(companies)
      .set({
        completionEvidencePolicy: {
          enabled: false,
          scope: "all",
          require: "either",
          countDescendants: true,
          ...policy,
        },
      })
      .where(eq(companies.id, company.companyId));
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId: company.companyId,
      title: "Task",
      status: "in_progress",
      priority: "medium",
    });
    return { ...company, issueId };
  }

  /** A task an agent owns, so the implicit-reopen path is reachable. */
  async function seedWithAssignedAgent() {
    const seeded = await seed();
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId: seeded.companyId,
      name: "Fixer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await ctx.db
      .update(issues)
      .set({ assigneeAgentId: agentId })
      .where(eq(issues.id, seeded.issueId));
    return seeded;
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function appFor(seeded: Seeded) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  function patch(seeded: Seeded, body: Record<string, unknown>) {
    return request(appFor(seeded)).patch(`/api/issues/${seeded.issueId}`).send(body);
  }

  async function addPullRequest(seeded: Seeded) {
    await ctx.db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      type: "pull_request",
      provider: "github",
      title: "PR",
      url: "https://example.test/pull/1",
      status: "open",
    });
  }

  async function statusOf(seeded: Seeded) {
    const row = await ctx.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0] ?? null);
    return row?.status ?? null;
  }

  it("completes a task without evidence while the gate is off", async () => {
    const seeded = await seed();
    await patch(seeded, { status: "done" }).expect(200);
    expect(await statusOf(seeded)).toBe("done");
  });

  it("refuses to complete a task with no evidence once the gate is on", async () => {
    const seeded = await seed({ enabled: true });

    const res = await patch(seeded, { status: "done" }).expect(422);

    expect(res.body.error).toContain("pull_request");
    // The refusal must leave the task where it was, not half-applied.
    expect(await statusOf(seeded)).toBe("in_progress");
  });

  it("completes the same task once a pull request is recorded", async () => {
    const seeded = await seed({ enabled: true });
    await addPullRequest(seeded);

    await patch(seeded, { status: "done" }).expect(200);

    expect(await statusOf(seeded)).toBe("done");
  });

  it("still allows cancelling a task that the gate would block", async () => {
    // Cancelling is not claiming the work landed, so evidence is irrelevant to
    // it. A gate that trapped abandoned work in progress would be a bug.
    const seeded = await seed({ enabled: true });

    await patch(seeded, { status: "cancelled" }).expect(200);

    expect(await statusOf(seeded)).toBe("cancelled");
  });

  it("moves a done task to human approved for a board user", async () => {
    const seeded = await seed();
    await patch(seeded, { status: "done" }).expect(200);

    await patch(seeded, { status: "human_approved" }).expect(200);

    expect(await statusOf(seeded)).toBe("human_approved");
  });

  it("treats an approved task as finished, exactly as it treats a done one", async () => {
    // `isClosedIssueStatus` named `done` and `cancelled` inline, so an approved
    // task read as *open work*. The visible consequence is the implicit reopen:
    // a human comment on finished work assigned to an agent sends it back to
    // `todo`. With the literals, an approved task did not reopen — it sat in a
    // terminal status that the route believed was still in flight.
    const seeded = await seedWithAssignedAgent();
    await patch(seeded, { status: "done" }).expect(200);
    await patch(seeded, { status: "human_approved" }).expect(200);

    await patch(seeded, { comment: "One more thought." }).expect(200);

    expect(await statusOf(seeded)).toBe("todo");
  });

  it("refuses human approval from a status other than done", async () => {
    const seeded = await seed();

    const res = await patch(seeded, { status: "human_approved" }).expect(422);

    expect(res.body.error).toContain("done");
    expect(await statusOf(seeded)).toBe("in_progress");
  });
});
