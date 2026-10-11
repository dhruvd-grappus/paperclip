import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentInstructionsRevisions,
  agents,
  companies,
  createDb,
  issues,
  projects,
  reportedProblems,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reportedProblemsService } from "../services/reported-problems.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PAPERCLIP_PROJECT_ID = "040be6a4-bbbd-4aed-8763-06fd8e54b0af";
const PAPERCLIP_FIXER_AGENT_ID = "e3ab0ce8-5bba-40cf-816a-108331f331c4";
const PAPERCLIP_CLARIFIER_AGENT_ID = "221ca6db-6cf1-49ff-bdf1-270a53c201f9";

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("reportedProblemsService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reported-problems-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(reportedProblems);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agentInstructionsRevisions);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
    });
    await db.insert(agents).values([
      { id: PAPERCLIP_FIXER_AGENT_ID, companyId, name: "Fixer", status: "active" },
      { id: PAPERCLIP_CLARIFIER_AGENT_ID, companyId, name: "Clarifier", status: "active" },
    ]);
    await db.insert(projects).values({
      id: PAPERCLIP_PROJECT_ID,
      companyId,
      name: "Paperclip",
    });
  }

  it("creates a backlog issue assigned to the fixer and a reported problem row", async () => {
    await seed();
    const svc = reportedProblemsService(db);

    const { problem, backlogIssue } = await svc.create(
      companyId,
      { title: "Broken preview", description: "The preview 500s." },
      { userId: "u1" },
    );

    expect(problem).not.toBeNull();
    expect(problem!.backlogIssueId).toBe(backlogIssue.id);
    expect(problem!.sourceIssueId).toBeNull();

    const created = await db.select().from(issues).then((rows) => rows[0]);
    expect(created).toBeDefined();
    expect(created!.status).toBe("backlog");
    expect(created!.assigneeAgentId).toBe(PAPERCLIP_FIXER_AGENT_ID);
    expect(created!.projectId).toBe(PAPERCLIP_PROJECT_ID);
    expect(created!.originKind).toBe("reported_problem");
  });

  it("captures the Clarifier's current AGENTS.md version at report time", async () => {
    await seed();
    await db.insert(agentInstructionsRevisions).values({
      id: randomUUID(),
      companyId,
      agentId: PAPERCLIP_CLARIFIER_AGENT_ID,
      version: 3,
      entryFile: "AGENTS.md",
      content: "v3",
    });
    const svc = reportedProblemsService(db);

    const { problem } = await svc.create(
      companyId,
      { title: "x", commentIds: [randomUUID()] },
      { agentId: PAPERCLIP_FIXER_AGENT_ID },
    );

    expect(problem!.agentInstructionsVersion).toBe(3);
    expect(problem!.reportedByAgentId).toBe(PAPERCLIP_FIXER_AGENT_ID);
    expect(problem!.commentIds).toHaveLength(1);
  });

  it("groups problems by version via listByVersion", async () => {
    await seed();
    await db.insert(agentInstructionsRevisions).values([
      { id: randomUUID(), companyId, agentId: PAPERCLIP_CLARIFIER_AGENT_ID, version: 1, entryFile: "AGENTS.md", content: "v1" },
      { id: randomUUID(), companyId, agentId: PAPERCLIP_CLARIFIER_AGENT_ID, version: 2, entryFile: "AGENTS.md", content: "v2" },
    ]);
    const svc = reportedProblemsService(db);

    await svc.create(companyId, { title: "one" }, { userId: "u1" });
    await svc.create(companyId, { title: "two" }, { userId: "u1" });

    const groups = await svc.listByVersion(companyId);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.version).toBe(2);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.problems).toHaveLength(2);
  });
});
