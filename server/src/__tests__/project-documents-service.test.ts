import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documentRevisions,
  documents,
  projectDocuments,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectDocumentService } from "../services/project-documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project document service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("projectDocumentService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof projectDocumentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-documents-service-");
    db = createDb(tempDb.connectionString);
    svc = projectDocumentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Project Vault Test",
      issuePrefix: `PV${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Vault Test Project",
      status: "active",
    });
    return { companyId, projectId };
  }

  it("creates a new project document with revision 1 and reports it back", async () => {
    const { projectId } = await createProject();

    const result = await svc.upsertProjectDocument({
      projectId,
      key: "rules",
      title: "Project rules",
      format: "markdown",
      body: "# Project rules\n\nFollow these conventions.",
    });

    expect(result.created).toBe(true);
    expect(result.document.key).toBe("rules");
    expect(result.document.title).toBe("Project rules");
    expect(result.document.format).toBe("markdown");
    expect(result.document.body).toContain("Follow these conventions.");
    expect(result.document.latestRevisionNumber).toBe(1);
    expect(result.document.latestRevisionId).toBeTruthy();

    const listed = await svc.listProjectDocuments(projectId);
    expect(listed.map((doc) => doc.key)).toEqual(["rules"]);

    const byKey = await svc.getProjectDocumentByKey(projectId, "rules");
    expect(byKey?.id).toBe(result.document.id);
  });

  it("creates a new revision on update and increments latestRevisionNumber + latestRevisionId", async () => {
    const { projectId } = await createProject();

    const created = await svc.upsertProjectDocument({
      projectId,
      key: "goals",
      title: "Goals",
      format: "markdown",
      body: "v1",
    });

    const updated = await svc.upsertProjectDocument({
      projectId,
      key: "goals",
      title: "Goals",
      format: "markdown",
      body: "v2",
      baseRevisionId: created.document.latestRevisionId,
    });

    expect(updated.created).toBe(false);
    expect(updated.document.latestRevisionNumber).toBe(2);
    expect(updated.document.latestRevisionId).not.toBe(created.document.latestRevisionId);
    expect(updated.document.body).toBe("v2");

    const revisions = await svc.listProjectDocumentRevisions(projectId, "goals");
    expect(revisions.map((rev) => rev.revisionNumber)).toEqual([2, 1]);
  });

  it("rejects updates with a stale baseRevisionId", async () => {
    const { projectId } = await createProject();

    const created = await svc.upsertProjectDocument({
      projectId,
      key: "repo-radius",
      title: "Repo radius",
      format: "markdown",
      body: "alpha",
    });

    await expect(
      svc.upsertProjectDocument({
        projectId,
        key: "repo-radius",
        title: "Repo radius",
        format: "markdown",
        body: "beta",
        baseRevisionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/updated by someone else|stale/) });

    // After the failed update the document must still reflect the original body/revision.
    const latest = await svc.getProjectDocumentByKey(projectId, "repo-radius");
    expect(latest?.body).toBe("alpha");
    expect(latest?.latestRevisionNumber).toBe(created.document.latestRevisionNumber);
  });

  it("createMigratedProjectDocument records source issue id and skips on conflict", async () => {
    const { companyId, projectId } = await createProject();
    const migratedFromIssueId = randomUUID();

    const first = await svc.createMigratedProjectDocument({
      companyId,
      projectId,
      key: "summary",
      format: "markdown",
      title: "Vault summary",
      body: "initial",
      migratedFromIssueId,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    });
    expect(first.link.migratedFromIssueId).toBe(migratedFromIssueId);
    expect(first.document.latestRevisionNumber).toBe(1);

    // Re-running the migration for the same (project, key) must surface the
    // conflict without altering existing rows.
    await expect(
      svc.createMigratedProjectDocument({
        companyId,
        projectId,
        key: "summary",
        format: "markdown",
        title: "Vault summary",
        body: "replay",
        migratedFromIssueId,
        createdAt: new Date("2025-01-02T00:00:00Z"),
        updatedAt: new Date("2025-01-02T00:00:00Z"),
      }),
    ).rejects.toBeDefined();

    const after = await svc.getProjectDocumentByKey(projectId, "summary");
    expect(after?.body).toBe("initial");
  });
});
