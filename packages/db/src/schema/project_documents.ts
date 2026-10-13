import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { documents } from "./documents.js";

/**
 * `project_documents` joins the shared `documents` / `document_revisions`
 * table to the `Project` entity. It mirrors `issue_documents`, `routine_documents`,
 * and `case_documents`, and is keyed on `(company_id, project_id, key)` so a project
 * can own one doc per logical vault slot (rules, goals, repo-radius, ...).
 *
 * The old vault layout stored these on a side-car `Vault: <project>` issue. The
 * GRA-667 migration moves those rows off the issue and onto the project; the
 * alias at `/api/issues/:id/documents/...` keeps the old issue path returning the
 * migrated content during the deprecation window.
 */
export const projectDocuments = pgTable(
  "project_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** When this row was migrated from a Vault: <project> issue, that legacy issue id is recorded here. */
    migratedFromIssueId: uuid("migrated_from_issue_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectKeyUq: uniqueIndex("project_documents_company_project_key_uq").on(
      table.companyId,
      table.projectId,
      table.key,
    ),
    documentUq: uniqueIndex("project_documents_document_uq").on(table.documentId),
    companyProjectUpdatedIdx: index("project_documents_company_project_updated_idx").on(
      table.companyId,
      table.projectId,
      table.updatedAt,
    ),
    companyProjectMigratedFromIdx: index("project_documents_migrated_from_issue_idx").on(
      table.companyId,
      table.migratedFromIssueId,
    ),
  }),
);
