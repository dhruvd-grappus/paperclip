import { describe, expect, it } from "vitest";
import { dashboardTaskMetrics, issueProjectId, runningTasksByProject } from "./dashboard-task-metrics";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const P1 = "c42fab6a-e603-4162-994e-82e21ad99950";
const P2 = "3f4ed346-c139-4173-8870-e55d460c6345";
const issue = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, status, projectId: null, updatedAt: "2026-09-27T10:00:00Z", completedAt: null, description: null, ...extra,
}) as any;

describe("dashboard task metrics", () => {
  it("counts done in the last 7 days, open, in progress and blocked needing attention", () => {
    const metrics = dashboardTaskMetrics([
      issue("a", "done", { completedAt: "2026-09-26T09:00:00Z" }),
      issue("b", "done", { completedAt: "2026-09-10T09:00:00Z" }),
      issue("c", "in_progress"),
      issue("d", "blocked", { blockerAttention: { state: "needs_attention" } }),
      issue("e", "blocked", { blockerAttention: { state: "covered" } }),
      issue("f", "cancelled"),
      issue("g", "todo"),
    ], NOW);
    expect(metrics).toEqual({
      doneLast7Days: 1, doneTotal: 2, inProgress: 1, open: 4, blocked: 2, blockedNeedingAttention: 1,
      needsAttention: 1, awaitingHuman: 0,
    });
  });

  it("counts needs-attention across stalled blockers and stalled reviews, ignoring closed work", () => {
    const metrics = dashboardTaskMetrics([
      issue("blocker-attention", "blocked", { blockerAttention: { state: "needs_attention" } }),
      issue("blocker-stalled", "blocked", { blockerAttention: { state: "stalled" } }),
      issue("blocker-covered", "blocked", { blockerAttention: { state: "covered" } }),
      issue("review-stalled", "in_review", { reviewAttention: { state: "stalled" } }),
      issue("review-covered", "in_review", { reviewAttention: { state: "covered" } }),
      // A finished task keeps whatever attention state it had; it needs nothing.
      issue("closed", "done", { completedAt: "2026-09-26T09:00:00Z", blockerAttention: { state: "needs_attention" } }),
    ], NOW);
    expect(metrics.needsAttention).toBe(3);
  });

  it("counts open tasks parked on a person, not ones an agent or monitor still owns", () => {
    const metrics = dashboardTaskMetrics([
      issue("reviewer", "in_review", { reviewAttention: { state: "covered", paths: [{ kind: "human_reviewer" }] } }),
      issue("question", "in_review", { reviewAttention: { state: "covered", paths: [{ kind: "interaction" }] } }),
      issue("approval", "in_review", { reviewAttention: { state: "covered", paths: [{ kind: "approval" }] } }),
      issue("agent", "in_progress", { reviewAttention: { state: "covered", paths: [{ kind: "active_run" }] } }),
      issue("monitor", "in_review", { reviewAttention: { state: "covered", paths: [{ kind: "monitor" }] } }),
      issue("settled", "done", { completedAt: "2026-09-26T09:00:00Z", reviewAttention: { state: "covered", paths: [{ kind: "human_reviewer" }] } }),
      issue("bare", "todo"),
    ], NOW);
    expect(metrics.awaitingHuman).toBe(3);
  });

  it("reads the project from projectId or the Slack Project: line", () => {
    expect(issueProjectId(issue("a", "todo", { projectId: P2 }))).toBe(P2);
    expect(issueProjectId(issue("a", "todo", { description: `Project: Unberry (${P1})\n\nStarted from Slack` }))).toBe(P1);
    expect(issueProjectId(issue("a", "todo", { description: "Mentions Project: nothing" }))).toBeNull();
  });

  it("groups running tasks by project, live runs first, no project last", () => {
    const groups = runningTasksByProject([
      issue("slack", "blocked", { description: `Project: Unberry (${P1})` }),
      issue("build", "in_progress", { projectId: P1 }),
      issue("sandbox-1", "in_progress", { projectId: P2 }),
      issue("sandbox-2", "in_progress", { projectId: P2 }),
      issue("orphan", "in_progress"),
      issue("idle", "todo", { projectId: P2 }),
    ], new Set(["slack"]));
    expect(groups.map((g) => [g.projectId, g.issues.map((i) => `${i.id}${i.live ? "*" : ""}`)])).toEqual([
      [P1, ["slack*", "build"]],
      [P2, ["sandbox-1", "sandbox-2"]],
      [null, ["orphan"]],
    ]);
  });
});

describe("human intervention needed", () => {
  it("lists blocked tasks started by people, longest waiting first", async () => {
    const { humanInterventionNeeded } = await import("./dashboard-task-metrics");
    const list = humanInterventionNeeded([
      issue("slack", "blocked", { originKind: "chat_channel", updatedAt: "2026-09-27T09:00:00Z" }),
      issue("ui-old", "blocked", { createdByUserId: "u1", updatedAt: "2026-09-26T09:00:00Z" }),
      issue("agent-child", "blocked", { createdByUserId: "u1", createdByAgentId: "a1" }),
      issue("agent", "blocked", { createdByAgentId: "a1" }),
      issue("ui-running", "in_progress", { createdByUserId: "u1" }),
    ]);
    expect(list.map((i) => i.id)).toEqual(["ui-old", "slack"]);
  });
});
