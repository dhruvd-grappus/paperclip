import { and, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import {
  WAITING_ON_HUMAN_UNASSIGNED,
  waitingOnHumanRows,
  type IssueStatus,
  type WaitingOnHumanRow,
} from "@paperclipai/shared";
import { attentionService } from "./attention.js";
import { issueService } from "./issues.js";
import { executionIssueCondition } from "./issue-visibility.js";

/**
 * "Waiting on you", built on the server (GRA-328).
 *
 * The list used to be derived in the browser from two whole-company payloads —
 * every task plus the entire attention feed — which meant the dashboard paid
 * for the full task list to render eight rows, and any client that wanted the
 * same list had to re-implement the rule. The rule itself still lives in
 * `@paperclipai/shared` so both sides agree on it; what moved here is the
 * *data*: this endpoint fetches exactly the tasks the rule can act on.
 *
 * Two task populations are read, because the rule needs both:
 *   • the candidates — parent, visible, non-routine tasks in `in_review` or
 *     `done`, which are the rows that come from task status alone;
 *   • the tasks the pending attention cards point at, whatever their status,
 *     because a card's row needs its task's parentage, owner and visibility to
 *     be placed (or dropped) correctly.
 */

/** Statuses that put a task on a person's desk on their own. */
const WAITING_STATUSES = ["in_review", "done"] as const;

const ROUTINE_ORIGIN_KIND = "routine_execution";

const rowSelect = {
  id: issues.id,
  companyId: issues.companyId,
  identifier: issues.identifier,
  title: issues.title,
  status: issues.status,
  updatedAt: issues.updatedAt,
  completedAt: issues.completedAt,
  hiddenAt: issues.hiddenAt,
  harnessKind: issues.harnessKind,
  conversationAgentId: issues.conversationAgentId,
  originKind: issues.originKind,
  parentId: issues.parentId,
  createdByUserId: issues.createdByUserId,
  responsibleUserId: issues.responsibleUserId,
  assigneeUserId: issues.assigneeUserId,
} as const;

export interface WaitingOnYouOptions {
  /** The board user whose feed the pending cards are read from. */
  userId: string;
  /**
   * Owner filter, matching {@link WaitingOnHumanRow.ownerUserId}: a user id, or
   * `"unassigned"` for the rows no person owns. Omitted, nothing is filtered.
   */
  ownerUserId?: string | null;
  now?: number;
}

export interface WaitingOnYouOwner {
  /** Null for the rows no person owns — the "unassigned" bucket. */
  userId: string | null;
  count: number;
}

export interface WaitingOnYouFeed {
  companyId: string;
  items: WaitingOnHumanRow[];
  /** Every owner present in the *unfiltered* list, so the picker keeps its options. */
  owners: WaitingOnYouOwner[];
  /** Size of the unfiltered list, for the badge and the "N of M" line. */
  totalCount: number;
}

export function waitingOnYouService(db: Db) {
  const attention = attentionService(db);
  const issuesSvc = issueService(db);

  return {
    list: async (
      companyId: string,
      options: WaitingOnYouOptions,
    ): Promise<WaitingOnYouFeed> => {
      const feed = await attention.list(companyId, {
        userId: options.userId,
        all: true,
        allowUnscopedAll: true,
      });

      const cardIssueIds = [
        ...new Set(
          feed.items
            .filter((item) => item.sourceKind === "issue_thread_interaction")
            .map((item) =>
              item.relatedIssue?.kind === "issue" ? item.relatedIssue.id : null,
            )
            .filter((id): id is string => Boolean(id)),
        ),
      ];

      // One query, two populations OR'd together: the status candidates, and
      // the tasks the cards hang off. Fetching the second set unfiltered is
      // deliberate — a hidden or child task has to arrive so the rule can drop
      // its card, which it cannot do from an absent row.
      const populations: SQL[] = [
        and(
          executionIssueCondition(),
          isNull(issues.parentId),
          inArray(issues.status, [...WAITING_STATUSES]),
          // The rule drops routine executions anyway; excluding them in SQL
          // keeps a company with a chatty schedule from paying for the rows.
          ne(issues.originKind, ROUTINE_ORIGIN_KIND),
        )!,
      ];
      if (cardIssueIds.length > 0) populations.push(inArray(issues.id, cardIssueIds));

      const rows = await db
        .select(rowSelect)
        .from(issues)
        .where(and(eq(issues.companyId, companyId), or(...populations)));

      const reviewAttention = await issuesSvc.listReviewAttention(companyId, rows);
      const issueRows = rows.map((row) => ({
        ...row,
        // The column is a plain text status; the shared row builder types it as
        // the issue status union, which the database does not narrow for us.
        status: row.status as IssueStatus,
        reviewAttention: reviewAttention.get(row.id) ?? null,
      }));

      const all = waitingOnHumanRows(feed.items, issueRows, { now: options.now });
      const counts = new Map<string | null, number>();
      for (const row of all) {
        counts.set(row.ownerUserId, (counts.get(row.ownerUserId) ?? 0) + 1);
      }
      const owners = [...counts.entries()]
        .map(([userId, count]) => ({ userId, count }))
        .sort((a, b) => b.count - a.count);

      const ownerUserId = options.ownerUserId ?? null;
      const items = ownerUserId
        ? all.filter((row) =>
            ownerUserId === WAITING_ON_HUMAN_UNASSIGNED
              ? row.ownerUserId == null
              : row.ownerUserId === ownerUserId,
          )
        : all;

      return { companyId, items, owners, totalCount: all.length };
    },
  };
}
