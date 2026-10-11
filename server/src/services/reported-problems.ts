import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentInstructionsRevisions, reportedProblems } from "@paperclipai/db";
import { issueService } from "./issues.js";

type Actor = {
  agentId?: string | null;
  userId?: string | null;
};

type CreateInput = {
  title: string;
  description?: string | null;
  sourceIssueId?: string | null;
  commentIds?: string[];
};

/**
 * Grappus deployment constants: the entities that own Paperclip's own
 * development loop. A reported problem is filed as a backlog issue in the
 * Paperclip project, assigned to the fixer agent, and tagged with the
 * Clarifier's current AGENTS.md version at report time.
 */
const PAPERCLIP_PROJECT_ID = "040be6a4-bbbd-4aed-8763-06fd8e54b0af";
const PAPERCLIP_FIXER_AGENT_ID = "e3ab0ce8-5bba-40cf-816a-108331f331c4";
const PAPERCLIP_CLARIFIER_AGENT_ID = "221ca6db-6cf1-49ff-bdf1-270a53c201f9";

export function reportedProblemsService(db: Db) {
  const issues = issueService(db);

  async function currentClarifierRevision(companyId: string) {
    const rows = await db
      .select()
      .from(agentInstructionsRevisions)
      .where(
        and(
          eq(agentInstructionsRevisions.companyId, companyId),
          eq(agentInstructionsRevisions.agentId, PAPERCLIP_CLARIFIER_AGENT_ID),
        ),
      )
      .orderBy(desc(agentInstructionsRevisions.version))
      .limit(1);
    return rows[0] ?? null;
  }

  async function create(companyId: string, input: CreateInput, actor: Actor) {
    const clarifierRevision = await currentClarifierRevision(companyId);

    const backlogIssue = await issues.create(companyId, {
      title: input.title,
      description: input.description ?? null,
      projectId: PAPERCLIP_PROJECT_ID,
      status: "backlog",
      assigneeAgentId: PAPERCLIP_FIXER_AGENT_ID,
      originKind: "reported_problem",
      originId: input.sourceIssueId ?? null,
      allowDuplicate: true,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
    });

    const rows = await db
      .insert(reportedProblems)
      .values({
        companyId,
        title: input.title,
        description: input.description ?? null,
        sourceIssueId: input.sourceIssueId ?? null,
        commentIds: input.commentIds ?? [],
        backlogIssueId: backlogIssue.id,
        agentInstructionsRevisionId: clarifierRevision?.id ?? null,
        agentInstructionsVersion: clarifierRevision?.version ?? null,
        reportedByAgentId: actor.agentId ?? null,
        reportedByUserId: actor.userId ?? null,
      })
      .returning();

    return { problem: rows[0] ?? null, backlogIssue };
  }

  async function list(companyId: string) {
    return db
      .select()
      .from(reportedProblems)
      .where(eq(reportedProblems.companyId, companyId))
      .orderBy(desc(reportedProblems.createdAt));
  }

  async function listByVersion(companyId: string) {
    const rows = await db
      .select({
        version: reportedProblems.agentInstructionsVersion,
        count: sql<number>`count(*)::int`,
      })
      .from(reportedProblems)
      .where(eq(reportedProblems.companyId, companyId))
      .groupBy(reportedProblems.agentInstructionsVersion)
      .orderBy(desc(reportedProblems.agentInstructionsVersion));

    const problems = await list(companyId);
    return rows.map((row) => ({
      version: row.version,
      count: row.count,
      problems: problems.filter((p) => p.agentInstructionsVersion === row.version),
    }));
  }

  return { create, list, listByVersion };
}
