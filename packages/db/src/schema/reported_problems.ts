import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { agentInstructionsRevisions } from "./agent_instructions_revisions.js";

/**
 * A "Report a Paperclip problem" submission. Each row is the user's report
 * (title, description, the source issue and selected comment ids) plus the
 * backlog issue that was filed for the fixer, and the AGENTS.md version the
 * Clarifier was on when the problem was reported. The version link is what
 * powers the problems-per-version breakdown on the "Reported problems" page.
 */
export const reportedProblems = pgTable(
  "reported_problems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    description: text("description"),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    commentIds: jsonb("comment_ids").$type<string[]>().notNull().default([]),
    backlogIssueId: uuid("backlog_issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentInstructionsRevisionId: uuid("agent_instructions_revision_id").references(
      () => agentInstructionsRevisions.id,
      { onDelete: "set null" },
    ),
    agentInstructionsVersion: integer("agent_instructions_version"),
    reportedByAgentId: uuid("reported_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    reportedByUserId: text("reported_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("reported_problems_company_created_idx").on(table.companyId, table.createdAt),
    companyVersionIdx: index("reported_problems_company_version_idx").on(
      table.companyId,
      table.agentInstructionsVersion,
    ),
    sourceIssueIdx: index("reported_problems_source_issue_idx").on(table.sourceIssueId),
    backlogIssueIdx: index("reported_problems_backlog_issue_idx").on(table.backlogIssueId),
  }),
);
