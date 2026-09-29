import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { waitingOnYouService } from "../services/waiting-on-you.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres waiting-on-you tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * GRA-328: the desk list is built server-side, skips routine executions, and
 * takes multi-select owner and project filters. These cover the two facts the
 * endpoint adds over the shared row builder — which tasks it fetches, and what
 * the filters do (and do not do) to the facet counts it reports alongside them.
 */
describeEmbeddedPostgres("waiting-on-you service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-waiting-on-you-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "WOY Co",
      issuePrefix: "WOY",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertProject(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(projects).values({ id, companyId, name });
    return id;
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    status: string;
    originKind?: string;
    createdByUserId?: string | null;
    projectId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      originKind: input.originKind ?? "manual",
      createdByUserId: input.createdByUserId ?? null,
      projectId: input.projectId ?? null,
    });
    return id;
  }

  it("lists tasks a person has to close out and leaves routine runs off", async () => {
    const companyId = await seed();
    const review = await insertIssue({
      companyId,
      identifier: "WOY-1",
      title: "Review the migration",
      status: "in_review",
    });
    const done = await insertIssue({
      companyId,
      identifier: "WOY-2",
      title: "Finished, unapproved",
      status: "done",
    });
    await insertIssue({
      companyId,
      identifier: "WOY-3",
      title: "Nightly sweep",
      status: "done",
      originKind: "routine_execution",
    });
    await insertIssue({
      companyId,
      identifier: "WOY-4",
      title: "Still running",
      status: "in_progress",
    });

    const feed = await waitingOnYouService(db).list(companyId, { userId: randomUUID() });
    expect(new Set(feed.items.map((row) => row.issueId))).toEqual(new Set([review, done]));
    expect(feed.totalCount).toBe(2);
  });

  it("takes several owners and projects at once, and ANDs the two axes", async () => {
    const companyId = await seed();
    const alice = randomUUID();
    const bob = randomUUID();
    const apollo = await insertProject(companyId, "Apollo");
    const borealis = await insertProject(companyId, "Borealis");

    const aliceApollo = await insertIssue({
      companyId,
      identifier: "WOY-1",
      title: "Alice on Apollo",
      status: "in_review",
      createdByUserId: alice,
      projectId: apollo,
    });
    const bobBorealis = await insertIssue({
      companyId,
      identifier: "WOY-2",
      title: "Bob on Borealis",
      status: "done",
      createdByUserId: bob,
      projectId: borealis,
    });
    await insertIssue({
      companyId,
      identifier: "WOY-3",
      title: "Somebody else, no project",
      status: "done",
      createdByUserId: randomUUID(),
    });
    const unowned = await insertIssue({
      companyId,
      identifier: "WOY-4",
      title: "Nobody's, unfiled",
      status: "done",
    });

    const svc = waitingOnYouService(db);
    const userId = randomUUID();

    const twoPeople = await svc.list(companyId, {
      userId,
      ownerUserIds: [alice, bob],
    });
    expect(new Set(twoPeople.items.map((row) => row.issueId))).toEqual(
      new Set([aliceApollo, bobBorealis]),
    );
    // Both pickers' options survive the filter that narrowed the list.
    expect(twoPeople.owners).toHaveLength(4);
    expect(twoPeople.projects).toHaveLength(3);
    expect(twoPeople.totalCount).toBe(4);

    const twoProjects = await svc.list(companyId, {
      userId,
      projectIds: [apollo, borealis],
    });
    expect(new Set(twoProjects.items.map((row) => row.issueId))).toEqual(
      new Set([aliceApollo, bobBorealis]),
    );

    // ANDed: two people, one project.
    const anded = await svc.list(companyId, {
      userId,
      ownerUserIds: [alice, bob],
      projectIds: [borealis],
    });
    expect(anded.items.map((row) => row.issueId)).toEqual([bobBorealis]);

    // The sentinels are ordinary selectable values.
    const nobody = await svc.list(companyId, {
      userId,
      ownerUserIds: ["unassigned"],
      projectIds: ["unfiled"],
    });
    expect(nobody.items.map((row) => row.issueId)).toEqual([unowned]);

    // An empty selection means "no filter", not "nothing matches".
    const empty = await svc.list(companyId, { userId, ownerUserIds: [], projectIds: [] });
    expect(empty.items).toHaveLength(4);
  });
});
