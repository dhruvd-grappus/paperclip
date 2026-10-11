import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentInstructionsRevisions } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { agentInstructionsService } from "./agent-instructions.js";

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

type Actor = {
  agentId?: string | null;
  userId?: string | null;
};

/**
 * Content versioning for an agent's live AGENTS.md entry file (V1, V2, V3, ...).
 * Distinct from `agent_config_revisions`, which versions the whole config pointer.
 * A snapshot is taken after every instructions-file edit; rollback writes a
 * stored revision's content back to the live file and appends a fresh version.
 */
export function agentInstructionsRevisionsService(db: Db) {
  const instructions = agentInstructionsService();

  async function nextVersion(companyId: string, agentId: string): Promise<number> {
    const rows = await db
      .select({ version: agentInstructionsRevisions.version })
      .from(agentInstructionsRevisions)
      .where(
        and(
          eq(agentInstructionsRevisions.companyId, companyId),
          eq(agentInstructionsRevisions.agentId, agentId),
        ),
      )
      .orderBy(desc(agentInstructionsRevisions.version))
      .limit(1);
    return (rows[0]?.version ?? 0) + 1;
  }

  async function snapshot(agent: AgentLike, actor: Actor, source: string) {
    let entryFile: string;
    let content: string;
    try {
      const bundle = await instructions.getBundle(agent);
      entryFile = bundle.entryFile;
      const detail = await instructions.readFile(agent, entryFile);
      content = detail.content;
    } catch {
      // The bundle is not configured (or the entry file is unreadable), so there
      // is no live AGENTS.md text to snapshot.
      return null;
    }
    const version = await nextVersion(agent.companyId, agent.id);
    const rows = await db
      .insert(agentInstructionsRevisions)
      .values({
        companyId: agent.companyId,
        agentId: agent.id,
        version,
        entryFile,
        content,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        source,
      })
      .returning();
    return rows[0] ?? null;
  }

  async function list(agentId: string) {
    return db
      .select()
      .from(agentInstructionsRevisions)
      .where(eq(agentInstructionsRevisions.agentId, agentId))
      .orderBy(desc(agentInstructionsRevisions.version));
  }

  async function get(agentId: string, revisionId: string) {
    const rows = await db
      .select()
      .from(agentInstructionsRevisions)
      .where(
        and(
          eq(agentInstructionsRevisions.agentId, agentId),
          eq(agentInstructionsRevisions.id, revisionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function rollback(agent: AgentLike, revisionId: string, actor: Actor) {
    const revision = await get(agent.id, revisionId);
    if (!revision) throw notFound("Revision not found");

    await instructions.writeFile(agent, revision.entryFile, revision.content, {});

    const version = await nextVersion(agent.companyId, agent.id);
    const rows = await db
      .insert(agentInstructionsRevisions)
      .values({
        companyId: agent.companyId,
        agentId: agent.id,
        version,
        entryFile: revision.entryFile,
        content: revision.content,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        source: "rollback",
        rolledBackFromRevisionId: revision.id,
      })
      .returning();
    return rows[0] ?? null;
  }

  return { snapshot, list, get, rollback };
}
