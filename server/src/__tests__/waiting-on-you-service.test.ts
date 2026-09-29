import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
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
 * filters by owner. These cover the two facts the endpoint adds over the shared
 * row builder — which tasks it fetches, and what the owner filter does to the
 * counts it reports alongside them.
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

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    status: string;
    originKind?: string;
    createdByUserId?: string | null;
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

  it("filters by owner while still reporting every owner and the full count", async () => {
    const companyId = await seed();
    const alice = randomUUID();
    const mine = await insertIssue({
      companyId,
      identifier: "WOY-1",
      title: "Alice's review",
      status: "in_review",
      createdByUserId: alice,
    });
    await insertIssue({
      companyId,
      identifier: "WOY-2",
      title: "Somebody else's",
      status: "done",
      createdByUserId: randomUUID(),
    });
    const unowned = await insertIssue({
      companyId,
      identifier: "WOY-3",
      title: "Nobody's",
      status: "done",
    });

    const svc = waitingOnYouService(db);
    const filtered = await svc.list(companyId, { userId: randomUUID(), ownerUserId: alice });
    expect(filtered.items.map((row) => row.issueId)).toEqual([mine]);
    // The picker's options survive the filter that narrowed the list.
    expect(filtered.owners).toHaveLength(3);
    expect(filtered.totalCount).toBe(3);

    const unassigned = await svc.list(companyId, {
      userId: randomUUID(),
      ownerUserId: "unassigned",
    });
    expect(unassigned.items.map((row) => row.issueId)).toEqual([unowned]);
  });
});
