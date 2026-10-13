#!/usr/bin/env -S pnpm exec tsx
/**
 * GRA-667 Vault → Project document migration.
 *
 * Walks every issue whose title starts with `Vault:`, copies each of its
 * `issue_documents` onto a `project_documents` row keyed by the issue's
 * `projectId`, and records the source issue id on the link so the issue-doc
 * alias at `/api/issues/:id/documents/:key` keeps returning the same body.
 *
 * Safe to re-run: it skips projects that already have a document for the
 * (projectId, key) pair (last-write-wins; older vault rows are kept as
 * revisions on the issue side, not duplicated here).
 *
 * Usage:
 *   pnpm exec tsx scripts/migrate-vault-issue-docs-to-project.ts [--dry-run]
 */

import { and, asc, eq, sql } from "drizzle-orm";
import {
  companies,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
  projectDocuments,
  projects,
} from "@paperclipai/db";

const PROJECT_DOCS_ENABLED_ENV = "PAPERCLIP_PROJECT_DOCS_ENABLED";

function logLine(line: string) {
  process.stdout.write(`${line}\n`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const projectDocsEnabled = process.env[PROJECT_DOCS_ENABLED_ENV] === "1";
  if (!projectDocsEnabled && !dryRun) {
    logLine(
      `[skip] ${PROJECT_DOCS_ENABLED_ENV} is not '1'. Pass --dry-run to preview, or flip the flag to run for real.`,
    );
    return;
  }

  const dbResult = createDb();
  const db = dbResult.db;
  const stop = () => dbResult.closeAll?.();
  try {
    const stats = {
      companiesScanned: 0,
      vaultIssuesScanned: 0,
      vaultIssuesMigrated: 0,
      vaultIssuesSkippedCompany: 0,
      documentsMigrated: 0,
      documentsSkippedExisting: 0,
    };

    const companyRows = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.id));
    stats.companiesScanned = companyRows.length;

    for (const company of companyRows) {
      const vaultIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          companyId: issues.companyId,
          projectId: issues.projectId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, company.id), sql`${issues.title} LIKE 'Vault:%'`));

      for (const vault of vaultIssues) {
        stats.vaultIssuesScanned += 1;
        if (!vault.projectId) {
          logLine(`[skip-issue] ${vault.identifier ?? vault.id}: no projectId (${vault.title})`);
          stats.vaultIssuesSkippedCompany += 1;
          continue;
        }

        const projectRow = await db
          .select({ id: projects.id, companyId: projects.companyId })
          .from(projects)
          .where(eq(projects.id, vault.projectId))
          .then((rows) => rows[0] ?? null);
        if (!projectRow) {
          logLine(`[skip-issue] ${vault.identifier ?? vault.id}: project ${vault.projectId} not found`);
          stats.vaultIssuesSkippedCompany += 1;
          continue;
        }

        const docs = await db
          .select({
            linkId: issueDocuments.id,
            key: issueDocuments.key,
            companyId: issueDocuments.companyId,
            documentId: issueDocuments.documentId,
            format: documents.format,
            title: documents.title,
            latestBody: documents.latestBody,
            latestRevisionId: documents.latestRevisionId,
            latestRevisionNumber: documents.latestRevisionNumber,
            createdByAgentId: documents.createdByAgentId,
            createdByUserId: documents.createdByUserId,
            updatedByAgentId: documents.updatedByAgentId,
            updatedByUserId: documents.updatedByUserId,
            createdAt: documents.createdAt,
            updatedAt: documents.updatedAt,
          })
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, vault.id), eq(issueDocuments.companyId, vault.companyId)));

        if (docs.length === 0) {
          logLine(`[no-docs] ${vault.identifier ?? vault.id}: nothing to migrate`);
          continue;
        }

        if (dryRun) {
          logLine(
            `[dry-run] would migrate ${vault.identifier ?? vault.id} (${vault.title}) → project ${projectRow.id}: ${docs.length} doc(s) (${docs.map((row) => row.key).join(", ")})`,
          );
          stats.vaultIssuesMigrated += 1;
          stats.documentsMigrated += docs.length;
          continue;
        }

        await db.transaction(async (tx) => {
          for (const doc of docs) {
            const alreadyThere = await tx
              .select({ id: projectDocuments.id })
              .from(projectDocuments)
              .where(
                and(
                  eq(projectDocuments.companyId, projectRow.companyId),
                  eq(projectDocuments.projectId, projectRow.id),
                  eq(projectDocuments.key, doc.key),
                ),
              )
              .then((rows) => rows[0] ?? null);
            if (alreadyThere) {
              logLine(`[skip-doc] ${vault.identifier ?? vault.id}/${doc.key}: project already has a doc`);
              stats.documentsSkippedExisting += 1;
              continue;
            }

            const newDocumentId = crypto.randomUUID();
            const newRevisionId = crypto.randomUUID();
            await tx.insert(documents).values({
              id: newDocumentId,
              companyId: projectRow.companyId,
              title: doc.title,
              format: doc.format,
              latestBody: doc.latestBody,
              latestRevisionId: newRevisionId,
              latestRevisionNumber: 1,
              createdByAgentId: doc.createdByAgentId,
              createdByUserId: doc.createdByUserId,
              updatedByAgentId: doc.updatedByAgentId,
              updatedByUserId: doc.updatedByUserId,
              lockedAt: null,
              lockedByAgentId: null,
              lockedByUserId: null,
              createdAt: doc.createdAt,
              updatedAt: doc.updatedAt,
            });

            await tx.insert(documentRevisions).values({
              id: newRevisionId,
              companyId: projectRow.companyId,
              documentId: newDocumentId,
              revisionNumber: 1,
              title: doc.title,
              format: doc.format,
              body: doc.latestBody,
              changeSummary: `Migrated from ${vault.identifier ?? vault.title ?? "vault issue"}`,
              createdByAgentId: doc.createdByAgentId,
              createdByUserId: doc.createdByUserId,
              createdAt: doc.createdAt,
            });

            await tx.insert(projectDocuments).values({
              companyId: projectRow.companyId,
              projectId: projectRow.id,
              documentId: newDocumentId,
              key: doc.key,
              migratedFromIssueId: vault.id,
              createdAt: doc.createdAt,
              updatedAt: doc.updatedAt,
            });

            stats.documentsMigrated += 1;
          }
          stats.vaultIssuesMigrated += 1;
        });
      }
    }

    logLine(JSON.stringify({ dryRun, ...stats }, null, 2));
  } finally {
    stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
