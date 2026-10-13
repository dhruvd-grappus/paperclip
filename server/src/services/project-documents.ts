import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documentRevisions, documents, projectDocuments, projects } from "@paperclipai/db";
import { issueDocumentKeySchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { isUniqueViolation } from "../db-errors.js";

/**
 * Project-level document service.
 *
 * Mirrors `documents.ts` (issue-documents) for the new `project_documents` membership.
 * Vault content that previously lived on side-car `Vault: <project>` issues now
 * sits here, keyed on `(companyId, projectId, key)` so a project can hold one
 * doc per logical vault slot (rules, goals, repo-radius, env, ...).
 *
 * The issue-doc route keeps a read-alias that proxies here for migrated Vault rows,
 * so legacy callers continue to work unchanged during the deprecation window.
 */

function normalizeDocumentKey(key: string) {
  const normalized = key.trim().toLowerCase();
  const parsed = issueDocumentKeySchema.safeParse(normalized);
  if (!parsed.success) {
    throw unprocessable("Invalid document key", parsed.error.issues);
  }
  return parsed.data;
}

export const projectDocumentSelect = {
  id: documents.id,
  companyId: documents.companyId,
  projectId: projectDocuments.projectId,
  key: projectDocuments.key,
  title: documents.title,
  format: documents.format,
  latestBody: documents.latestBody,
  latestRevisionId: documents.latestRevisionId,
  latestRevisionNumber: documents.latestRevisionNumber,
  createdByAgentId: documents.createdByAgentId,
  createdByUserId: documents.createdByUserId,
  updatedByAgentId: documents.updatedByAgentId,
  updatedByUserId: documents.updatedByUserId,
  lockedAt: documents.lockedAt,
  lockedByAgentId: documents.lockedByAgentId,
  lockedByUserId: documents.lockedByUserId,
  sourceTrust: documents.sourceTrust,
  migratedFromIssueId: projectDocuments.migratedFromIssueId,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
} as const;

export function mapProjectDocumentRow(
  row: {
    id: string;
    companyId: string;
    projectId: string;
    key: string;
    title: string | null;
    format: string;
    latestBody: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    updatedByAgentId: string | null;
    updatedByUserId: string | null;
    lockedAt: Date | null;
    lockedByAgentId: string | null;
    lockedByUserId: string | null;
    sourceTrust: typeof documents.$inferSelect.sourceTrust;
    migratedFromIssueId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  includeBody: boolean,
) {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    key: row.key,
    title: row.title,
    format: row.format,
    ...(includeBody ? { body: row.latestBody } : {}),
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    lockedAt: row.lockedAt,
    lockedByAgentId: row.lockedByAgentId,
    lockedByUserId: row.lockedByUserId,
    sourceTrust: row.sourceTrust ?? null,
    migratedFromIssueId: row.migratedFromIssueId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function projectDocumentService(db: Db) {
  return {
    listProjectDocuments: async (projectId: string) => {
      const rows = await db
        .select(projectDocumentSelect)
        .from(projectDocuments)
        .innerJoin(documents, eq(projectDocuments.documentId, documents.id))
        .where(eq(projectDocuments.projectId, projectId))
        .orderBy(asc(projectDocuments.key), desc(documents.updatedAt));
      return rows.map((row) => mapProjectDocumentRow(row, true));
    },

    getProjectDocumentByKey: async (projectId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      const row = await db
        .select(projectDocumentSelect)
        .from(projectDocuments)
        .innerJoin(documents, eq(projectDocuments.documentId, documents.id))
        .where(and(eq(projectDocuments.projectId, projectId), eq(projectDocuments.key, key)))
        .then((rows) => rows[0] ?? null);
      return row ? mapProjectDocumentRow(row, true) : null;
    },

    listProjectDocumentRevisions: async (projectId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      return db
        .select({
          id: documentRevisions.id,
          companyId: documentRevisions.companyId,
          documentId: documentRevisions.documentId,
          projectId: projectDocuments.projectId,
          key: projectDocuments.key,
          revisionNumber: documentRevisions.revisionNumber,
          title: documentRevisions.title,
          format: documentRevisions.format,
          body: documentRevisions.body,
          changeSummary: documentRevisions.changeSummary,
          createdByAgentId: documentRevisions.createdByAgentId,
          createdByUserId: documentRevisions.createdByUserId,
          createdAt: documentRevisions.createdAt,
        })
        .from(projectDocuments)
        .innerJoin(documents, eq(projectDocuments.documentId, documents.id))
        .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
        .where(and(eq(projectDocuments.projectId, projectId), eq(projectDocuments.key, key)))
        .orderBy(desc(documentRevisions.revisionNumber));
    },

    upsertProjectDocument: async (input: {
      projectId: string;
      key: string;
      title?: string | null;
      format: string;
      body: string;
      changeSummary?: string | null;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      createdByRunId?: string | null;
      sourceTrust?: typeof documents.$inferInsert.sourceTrust;
      migratedFromIssueId?: string | null;
    }) => {
      const key = normalizeDocumentKey(input.key);
      const project = await db
        .select({ id: projects.id, companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");

      try {
        return await db.transaction(async (tx) => {
          const now = new Date();
          const existing = await tx
            .select({
              id: documents.id,
              companyId: documents.companyId,
              projectId: projectDocuments.projectId,
              key: projectDocuments.key,
              title: documents.title,
              format: documents.format,
              latestBody: documents.latestBody,
              latestRevisionId: documents.latestRevisionId,
              latestRevisionNumber: documents.latestRevisionNumber,
              createdByAgentId: documents.createdByAgentId,
              createdByUserId: documents.createdByUserId,
              updatedByAgentId: documents.updatedByAgentId,
              updatedByUserId: documents.updatedByUserId,
              lockedAt: documents.lockedAt,
              lockedByAgentId: documents.lockedByAgentId,
              lockedByUserId: documents.lockedByUserId,
              sourceTrust: documents.sourceTrust,
              createdAt: documents.createdAt,
              updatedAt: documents.updatedAt,
            })
            .from(projectDocuments)
            .innerJoin(documents, eq(projectDocuments.documentId, documents.id))
            .where(and(eq(projectDocuments.projectId, project.id), eq(projectDocuments.key, key)))
            .then((rows) => rows[0] ?? null);

          if (existing) {
            if (existing.lockedAt) {
              throw conflict("Document is locked", {
                key: existing.key,
                documentId: existing.id,
                lockedAt: existing.lockedAt,
              });
            }

            if (!input.baseRevisionId) {
              throw conflict("Document update requires baseRevisionId. GET the current document, read its body and latestRevisionId, then set baseRevisionId to that latestRevisionId when updating.", {
                currentRevisionId: existing.latestRevisionId,
              });
            }
            if (input.baseRevisionId !== existing.latestRevisionId) {
              throw conflict("Document was updated by someone else", {
                currentRevisionId: existing.latestRevisionId,
              });
            }

            const nextRevisionNumber = existing.latestRevisionNumber + 1;
            const [revision] = await tx
              .insert(documentRevisions)
              .values({
                companyId: project.companyId,
                documentId: existing.id,
                revisionNumber: nextRevisionNumber,
                title: input.title ?? null,
                format: input.format,
                body: input.body,
                changeSummary: input.changeSummary ?? null,
                createdByAgentId: input.createdByAgentId ?? null,
                createdByUserId: input.createdByUserId ?? null,
                createdByRunId: input.createdByRunId ?? null,
                createdAt: now,
              })
              .returning();

            await tx
              .update(documents)
              .set({
                title: input.title ?? null,
                format: input.format,
                latestBody: input.body,
                latestRevisionId: revision.id,
                latestRevisionNumber: nextRevisionNumber,
                updatedByAgentId: input.createdByAgentId ?? null,
                updatedByUserId: input.createdByUserId ?? null,
                sourceTrust: input.sourceTrust ?? null,
                updatedAt: now,
              })
              .where(eq(documents.id, existing.id));

            await tx
              .update(projectDocuments)
              .set({ updatedAt: now })
              .where(eq(projectDocuments.documentId, existing.id));

            return {
              created: false as const,
              document: {
                ...existing,
                title: input.title ?? null,
                format: input.format,
                body: input.body,
                latestRevisionId: revision.id,
                latestRevisionNumber: nextRevisionNumber,
                updatedByAgentId: input.createdByAgentId ?? null,
                updatedByUserId: input.createdByUserId ?? null,
                sourceTrust: input.sourceTrust ?? null,
                updatedAt: now,
              },
            };
          }

          if (input.baseRevisionId) {
            throw conflict("Document does not exist yet", { key });
          }

          const [document] = await tx
            .insert(documents)
            .values({
              companyId: project.companyId,
              title: input.title ?? null,
              format: input.format,
              latestBody: input.body,
              latestRevisionId: null,
              latestRevisionNumber: 1,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              updatedByAgentId: input.createdByAgentId ?? null,
              updatedByUserId: input.createdByUserId ?? null,
              lockedAt: null,
              lockedByAgentId: null,
              lockedByUserId: null,
              sourceTrust: input.sourceTrust ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

          const [revision] = await tx
            .insert(documentRevisions)
            .values({
              companyId: project.companyId,
              documentId: document.id,
              revisionNumber: 1,
              title: input.title ?? null,
              format: input.format,
              body: input.body,
              changeSummary: input.changeSummary ?? null,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              createdByRunId: input.createdByRunId ?? null,
              createdAt: now,
            })
            .returning();

          await tx
            .update(documents)
            .set({ latestRevisionId: revision.id })
            .where(eq(documents.id, document.id));

          await tx.insert(projectDocuments).values({
            companyId: project.companyId,
            projectId: project.id,
            documentId: document.id,
            key,
            migratedFromIssueId: input.migratedFromIssueId ?? null,
            createdAt: now,
            updatedAt: now,
          });

          return {
            created: true as const,
            document: {
              id: document.id,
              companyId: project.companyId,
              projectId: project.id,
              key,
              title: document.title,
              format: document.format,
              body: document.latestBody,
              latestRevisionId: revision.id,
              latestRevisionNumber: 1,
              createdByAgentId: document.createdByAgentId,
              createdByUserId: document.createdByUserId,
              updatedByAgentId: document.updatedByAgentId,
              updatedByUserId: document.updatedByUserId,
              lockedAt: document.lockedAt,
              lockedByAgentId: document.lockedByAgentId,
              lockedByUserId: document.lockedByUserId,
              sourceTrust: document.sourceTrust ?? null,
              migratedFromIssueId: input.migratedFromIssueId ?? null,
              createdAt: document.createdAt,
              updatedAt: document.updatedAt,
            },
          };
        });
      } catch (error) {
        if (isUniqueViolation(error, "project_documents_company_project_key_uq")) {
          throw conflict("Document key already exists on this project", { key });
        }
        throw error;
      }
    },

    /**
     * Returns true when the project already has a project_documents row for the
     * given key. Used by the migration script to decide whether to merge or skip.
     */
    projectDocumentExists: async (projectId: string, key: string) => {
      const row = await db
        .select({ id: projectDocuments.id })
        .from(projectDocuments)
        .where(and(eq(projectDocuments.projectId, projectId), eq(projectDocuments.key, key)))
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },

    /**
     * Backfill helper used by the one-shot migration that lifts vault docs from
     * the legacy `Vault: <project>` issue onto the project. Creates the document
     * (and first revision) directly without going through the upsert's locks or
     * base-revision checks; the migrated content already exists.
     */
    createMigratedProjectDocument: async (input: {
      companyId: string;
      projectId: string;
      key: string;
      format: string;
      title: string | null;
      body: string;
      migratedFromIssueId: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      createdAt: Date;
      updatedAt: Date;
    }) => {
      return db.transaction(async (tx) => {
        const [document] = await tx
          .insert(documents)
          .values({
            companyId: input.companyId,
            title: input.title,
            format: input.format,
            latestBody: input.body,
            latestRevisionId: null,
            latestRevisionNumber: 1,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            lockedAt: null,
            lockedByAgentId: null,
            lockedByUserId: null,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
          })
          .returning();

        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: input.companyId,
            documentId: document.id,
            revisionNumber: 1,
            title: input.title,
            format: input.format,
            body: input.body,
            changeSummary: "Migrated from Vault: issue",
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: input.createdAt,
          })
          .returning();

        await tx
          .update(documents)
          .set({ latestRevisionId: revision.id })
          .where(eq(documents.id, document.id));

        const [link] = await tx
          .insert(projectDocuments)
          .values({
            companyId: input.companyId,
            projectId: input.projectId,
            documentId: document.id,
            key: input.key,
            migratedFromIssueId: input.migratedFromIssueId,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
          })
          .returning();

        return { document, revision, link };
      });
    },
  };
}

export type ProjectDocumentService = ReturnType<typeof projectDocumentService>;
