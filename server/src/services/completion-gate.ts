import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issueWorkProducts, issues } from "@paperclipai/db";
import {
  completionEvidencePolicyFromStorage,
  describeCompletionGateFailure,
  evaluateCompletionGate,
  type CompletionEvidencePolicy,
  type CompletionGateResult,
} from "@paperclipai/shared";

export interface CompletionGateIssue {
  id: string;
  companyId: string;
  parentId: string | null;
}

export interface CompletionGateDecision extends CompletionGateResult {
  policy: CompletionEvidencePolicy;
  /** Null when the move is allowed. */
  message: string | null;
}

const ALLOWED: Omit<CompletionGateDecision, "policy"> = {
  allowed: true,
  inScope: false,
  reason: null,
  presentTypes: [],
  message: null,
};

export function completionGateService(db: Db) {
  async function getPolicy(companyId: string): Promise<CompletionEvidencePolicy> {
    const row = await db
      .select({ policy: companies.completionEvidencePolicy })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return completionEvidencePolicyFromStorage(row?.policy);
  }

  async function hasChildren(issue: CompletionGateIssue): Promise<boolean> {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, issue.companyId), eq(issues.parentId, issue.id)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row != null;
  }

  async function listWorkProducts(issue: CompletionGateIssue, includeDescendants: boolean) {
    const selection = {
      issueId: issueWorkProducts.issueId,
      type: issueWorkProducts.type,
      url: issueWorkProducts.url,
      status: issueWorkProducts.status,
    };
    if (!includeDescendants) {
      return db
        .select(selection)
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, issue.companyId),
            eq(issueWorkProducts.issueId, issue.id),
          ),
        );
    }
    // The whole subtree, not just direct children: an umbrella task can be two
    // levels above the task that actually opened the pull request.
    return db
      .select(selection)
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, issue.companyId),
          sql<boolean>`
            ${issueWorkProducts.issueId} IN (
              WITH RECURSIVE issue_tree(id) AS (
                SELECT ${issues.id}
                FROM ${issues}
                WHERE ${issues.companyId} = ${issue.companyId}
                  AND ${issues.id} = ${issue.id}
                UNION ALL
                SELECT child.id
                FROM ${issues} child
                JOIN issue_tree parent ON child.parent_id = parent.id
                WHERE child.company_id = ${issue.companyId}
              )
              SELECT id FROM issue_tree
            )
          `,
        ),
      );
  }

  /**
   * Whether this task may move to a completed status right now.
   *
   * Reads the company policy on every call rather than caching it. A gate that
   * keeps enforcing a rule an administrator just turned off is worse than an
   * extra query on a status change, which is not a hot path.
   */
  async function evaluate(issue: CompletionGateIssue): Promise<CompletionGateDecision> {
    const policy = await getPolicy(issue.companyId);
    if (!policy.enabled) return { ...ALLOWED, policy };

    const isRoot = issue.parentId == null;
    // Only ask about children when the answer can change the outcome.
    const children = policy.scope === "parents" ? await hasChildren(issue) : false;
    if (policy.scope === "parents" && !children) return { ...ALLOWED, policy };
    if (policy.scope === "roots" && !isRoot) return { ...ALLOWED, policy };

    const rows = await listWorkProducts(issue, policy.countDescendants);
    const own = rows.filter((row) => row.issueId === issue.id);
    const descendants = rows.filter((row) => row.issueId !== issue.id);

    const result = evaluateCompletionGate(policy, {
      hasChildren: children,
      isRoot,
      ownWorkProducts: own,
      descendantWorkProducts: descendants,
    });
    return {
      ...result,
      policy,
      message: result.allowed ? null : describeCompletionGateFailure(result),
    };
  }

  return { evaluate, getPolicy };
}

export type CompletionGateService = ReturnType<typeof completionGateService>;

export type HumanApprovalRefusal = "actor_not_human" | "not_done";

/**
 * Whether this actor may move this task to `human_approved`, and why not.
 *
 * Pure and separate from the route so the rule can be tested without standing
 * up an authenticated agent: the interesting case is precisely the one the
 * board-actor route harness cannot express.
 */
export function checkHumanApprovalTransition(input: {
  actorType: "agent" | "board" | string;
  actorUserId: string | null | undefined;
  fromStatus: string;
  toStatus: string;
}): HumanApprovalRefusal | null {
  if (input.toStatus !== "human_approved") return null;
  if (input.fromStatus === "human_approved") return null;
  if (input.actorType !== "board" || !input.actorUserId) return "actor_not_human";
  if (input.fromStatus !== "done") return "not_done";
  return null;
}

export const HUMAN_APPROVAL_REFUSAL_MESSAGES: Record<HumanApprovalRefusal, string> = {
  actor_not_human: "Only a person can mark a task human approved",
  not_done: "A task can only be marked human approved once it is done",
};
