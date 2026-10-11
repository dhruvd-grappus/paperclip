import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Content snapshots of an agent's live AGENTS.md entry file. Each row is one
 * labelled version (V1, V2, V3, ...). A new row is appended every time the
 * managed instructions entry file is edited, and a rollback writes the stored
 * content back to the live file and appends a fresh version.
 *
 * This is intentionally distinct from `agent_config_revisions`, which snapshots
 * the agent's whole configuration pointer (changedKeys + before/after config),
 * not the AGENTS.md file text itself.
 */
export const agentInstructionsRevisions = pgTable(
  "agent_instructions_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    entryFile: text("entry_file").notNull().default("AGENTS.md"),
    content: text("content").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    source: text("source").notNull().default("edit"),
    rolledBackFromRevisionId: uuid("rolled_back_from_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentVersionUq: uniqueIndex("agent_instructions_revisions_company_agent_version_uq").on(
      table.companyId,
      table.agentId,
      table.version,
    ),
    companyAgentCreatedIdx: index("agent_instructions_revisions_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    agentCreatedIdx: index("agent_instructions_revisions_agent_created_idx").on(
      table.agentId,
      table.createdAt,
    ),
  }),
);
