import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BLOCKED: NativeStatusDecision = {
  policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
  statusAction: "blocked",
  toStatus: "blocked",
  reasonCode: "task_wide_blocker_bound",
  unblockDescriptor: null,
  effects: [],
};

describeEmbeddedPostgres("native status decision: a child that blocks wakes its parent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-child-blocked-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ChildBlocked", issuePrefix: "CBW" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native worker",
      adapterType: "codex_local",
      status: "running",
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedChildRun(input: { parentId: string | null; priorStatus: string }) {
    const issueId = randomUUID();
    const contractId = randomUUID();
    const runId = randomUUID();
    const contractSha256 = `contract-${contractId}`;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      parentId: input.parentId,
      title: "Build: needs a token",
      status: input.priorStatus,
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "child-blocked-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "child-blocked-v1",
        objective: "Push the branch",
        criteria: [{ id: "objective", requirement: "Push the branch" }],
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: randomUUID(),
      runnerInstanceId: randomUUID(),
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      contextSnapshot: { issueId },
    });
    const resultId = randomUUID();
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fp-${resultId}`,
      schemaStatus: "accepted",
      resultJson: {},
      canonicalSha256: `sha-${resultId}`,
    });
    const assessmentId = randomUUID();
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: input.priorStatus,
      priorStatusVersion: 0,
      policyVersion: "child-blocked-v1",
      assessmentJson: {},
      inputDigest: `digest-${assessmentId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "arbitrating",
      attempt: 0,
      resultId,
    });
    return { issueId, runId, assessmentId };
  }

  async function seedParent() {
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Slack task waiting on its build",
      status: "blocked",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    return parentId;
  }

  async function commitBlocked(child: Awaited<ReturnType<typeof seedChildRun>>, priorStatus: string) {
    await commitNativeStatusDecision({
      db,
      companyId,
      issueId: child.issueId,
      runId: child.runId,
      assessmentId: child.assessmentId,
      priorStatus,
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision: BLOCKED,
    });
  }

  function childBlockedWakes(parentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "issue_child_blocked"),
        ),
      )
      .then((rows) => rows.filter((row) => (row.payload as Record<string, unknown>)?.issueId === parentId));
  }

  it("queues one issue_child_blocked wake for the parent assignee", async () => {
    const parentId = await seedParent();
    const child = await seedChildRun({ parentId, priorStatus: "in_progress" });
    await commitBlocked(child, "in_progress");

    const wakes = await childBlockedWakes(parentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId,
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      payload: {
        issueId: parentId,
        blockedChildIssueId: child.issueId,
        _paperclipWakeContext: {
          issueId: parentId,
          wakeReason: "issue_child_blocked",
          blockedChildIssueId: child.issueId,
        },
      },
    });
  });

  it("does not wake anyone for a top-level issue or a child that was already blocked", async () => {
    const orphan = await seedChildRun({ parentId: null, priorStatus: "in_progress" });
    await commitBlocked(orphan, "in_progress");

    const parentId = await seedParent();
    const alreadyBlocked = await seedChildRun({ parentId, priorStatus: "blocked" });
    await commitBlocked(alreadyBlocked, "blocked");

    expect(await childBlockedWakes(parentId)).toHaveLength(0);
    const all = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "issue_child_blocked"),
        ),
      );
    expect(all.every((row) => (row.payload as Record<string, unknown>)?.blockedChildIssueId !== orphan.issueId)).toBe(true);
  });
});
