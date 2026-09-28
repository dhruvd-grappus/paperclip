import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueWorkProducts, issues } from "@paperclipai/db";
import type { CompletionEvidencePolicy } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { completionGateService } from "../services/completion-gate.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres completion gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const OFF: CompletionEvidencePolicy = {
  enabled: false,
  scope: "all",
  require: "either",
  countDescendants: true,
};

describeEmbeddedPostgres("completion gate service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-completion-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(policy: CompletionEvidencePolicy) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      completionEvidencePolicy: policy,
    });
    return companyId;
  }

  let issueCounter = 0;

  async function seedIssue(companyId: string, parentId: string | null = null) {
    const id = randomUUID();
    issueCounter += 1;
    await db.insert(issues).values({
      id,
      companyId,
      identifier: `GATE-${issueCounter}`,
      title: "Task",
      status: "in_progress",
      parentId,
    });
    return { id, companyId, parentId };
  }

  async function seedWorkProduct(
    issue: { id: string; companyId: string },
    type: string,
    overrides: { url?: string | null; status?: string } = {},
  ) {
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId: issue.companyId,
      issueId: issue.id,
      type,
      provider: "github",
      title: type,
      url: overrides.url === undefined ? "https://example.test/1" : overrides.url,
      status: overrides.status ?? "open",
    });
  }

  it("allows every completion while the gate is off, evidence or not", async () => {
    const companyId = await seedCompany(OFF);
    const issue = await seedIssue(companyId);

    const decision = await completionGateService(db).evaluate(issue);

    expect(decision.allowed).toBe(true);
    expect(decision.inScope).toBe(false);
    expect(decision.message).toBeNull();
  });

  it("blocks a task with no evidence and names what is missing", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true });
    const issue = await seedIssue(companyId);

    const decision = await completionGateService(db).evaluate(issue);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing_any");
    expect(decision.message).toContain("pull_request");
    expect(decision.message).toContain("No evidence work product is recorded");
  });

  it("accepts an artifact alone under the either rule", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true });
    const issue = await seedIssue(companyId);
    await seedWorkProduct(issue, "artifact", { url: null });

    const decision = await completionGateService(db).evaluate(issue);

    expect(decision.allowed).toBe(true);
    expect(decision.presentTypes).toEqual(["artifact"]);
  });

  it("rejects a branch as evidence", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true });
    const issue = await seedIssue(companyId);
    await seedWorkProduct(issue, "branch");

    const decision = await completionGateService(db).evaluate(issue);

    expect(decision.allowed).toBe(false);
    expect(decision.presentTypes).toEqual([]);
  });

  it("rejects a closed pull request as evidence", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true });
    const issue = await seedIssue(companyId);
    await seedWorkProduct(issue, "pull_request", { status: "closed" });

    const decision = await completionGateService(db).evaluate(issue);

    expect(decision.allowed).toBe(false);
  });

  it("requires both legs under the both rule and says which one is absent", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true, require: "both" });
    const issue = await seedIssue(companyId);
    await seedWorkProduct(issue, "pull_request");

    const decision = await completionGateService(db).evaluate(issue);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing_artifact");

    await seedWorkProduct(issue, "preview_url");
    expect((await completionGateService(db).evaluate(issue)).allowed).toBe(true);
  });

  it("credits a parent with evidence recorded two levels down", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true });
    const parent = await seedIssue(companyId);
    const child = await seedIssue(companyId, parent.id);
    const grandchild = await seedIssue(companyId, child.id);
    await seedWorkProduct(grandchild, "pull_request");

    const decision = await completionGateService(db).evaluate(parent);

    expect(decision.allowed).toBe(true);
    expect(decision.presentTypes).toEqual(["pull_request"]);
  });

  it("ignores subtask evidence when countDescendants is off", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true, countDescendants: false });
    const parent = await seedIssue(companyId);
    const child = await seedIssue(companyId, parent.id);
    await seedWorkProduct(child, "pull_request");

    expect((await completionGateService(db).evaluate(parent)).allowed).toBe(false);
  });

  it("leaves a childless task alone under the parents scope", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true, scope: "parents" });
    const parent = await seedIssue(companyId);
    const child = await seedIssue(companyId, parent.id);

    // The leaf is out of scope even though it has no evidence at all.
    expect((await completionGateService(db).evaluate(child)).allowed).toBe(true);
    expect((await completionGateService(db).evaluate(parent)).allowed).toBe(false);
  });

  it("leaves a subtask alone under the roots scope", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true, scope: "roots" });
    const parent = await seedIssue(companyId);
    const child = await seedIssue(companyId, parent.id);

    expect((await completionGateService(db).evaluate(child)).allowed).toBe(true);
    expect((await completionGateService(db).evaluate(parent)).allowed).toBe(false);
  });

  it("does not count another company's work products", async () => {
    const companyId = await seedCompany({ ...OFF, enabled: true });
    const otherCompanyId = await seedCompany({ ...OFF, enabled: true });
    const issue = await seedIssue(companyId);
    // Same issue id is impossible across companies, so the realistic leak is a
    // row whose company was rewritten; assert the company filter holds.
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      issueId: issue.id,
      type: "pull_request",
      provider: "github",
      title: "PR",
      url: "https://example.test/1",
      status: "open",
    });

    expect((await completionGateService(db).evaluate(issue)).allowed).toBe(false);
  });

  it("falls back to the shipped default when the stored policy is malformed", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      // A hand-edited or pre-migration row. Failing open is deliberate: a
      // malformed policy must not make every task uncompletable.
      completionEvidencePolicy: { enabled: "yes" } as never,
    });

    expect(await completionGateService(db).getPolicy(companyId)).toEqual({
      enabled: false,
      scope: "all",
      require: "either",
      countDescendants: true,
    });
  });
});
