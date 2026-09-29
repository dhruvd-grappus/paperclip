import type { AttentionItem, Issue } from "@paperclipai/shared";
import { attentionDetailLine, attentionTaskRef } from "./attention";
import { isVisibleWorkTask } from "./task-visibility";

/**
 * "Waiting on you" (GRA-296): the tasks whose next move belongs to a person.
 *
 * Four things stop a task on a human, and the dashboard used to surface none
 * of them together — the Human Intervention panel only lists `blocked` tasks a
 * person *started*, and the metric cards only count:
 *
 *   • a pending question   (`ask_user_questions`)
 *   • a pending confirmation (`request_confirmation` and its checkbox / verdict
 *     / plan-approval variants)
 *   • a task parked in `in_review`
 *   • a task an agent called `done` that no person has signed off yet, i.e.
 *     everything short of `human_approved`
 *
 * Questions and confirmations come from the attention feed rather than from the
 * issue list: the feed is where the server already resolved *which* card is
 * pending, what it asks, and who is allowed to answer it. `in_review` and
 * `done` come from the issue list, because a review with no pending card raises
 * no feed row at all until it stalls, and a finished task raises none ever —
 * and those are exactly the states this widget is asked to show.
 *
 * Hidden, harness and chat-container tasks never appear. The task list endpoint
 * already applies the server's visibility rule, and the attention feed drops
 * cards raised on a hidden task, so in practice neither source offers one; the
 * check here is the last line of defence for a caller that passes a list from
 * somewhere else.
 *
 * Parent tasks only. A subtask's question or review is a step inside work the
 * parent already represents, so listing both turns one thing to look at into a
 * pile; the desk stays at the granularity a person assigns work at.
 *
 * One row per task. A task in review that also has a pending confirmation is
 * one thing to go look at, not two.
 */

export type WaitingReason = "question" | "confirmation" | "in_review" | "done_unapproved";

const REASON_LABELS: Record<WaitingReason, string> = {
  question: "question to answer",
  confirmation: "confirmation to give",
  in_review: "in review",
  done_unapproved: "done, needs your approval",
};

export function waitingReasonLabel(reason: WaitingReason): string {
  return REASON_LABELS[reason];
}

export interface WaitingOnHumanRow {
  /** Task id when known, else the feed dedup key — used as the React key. */
  key: string;
  issueId: string | null;
  identifier: string | null;
  title: string;
  /** In-app link to the task (or to the row's own surface as a fallback). */
  href: string | null;
  /** Deduped, in display order: question, confirmation, then in_review. */
  reasons: WaitingReason[];
  /** What the pending card asks, when the feed carried an excerpt. */
  detail: string | null;
  /** ISO timestamp this task has been waiting since (oldest signal wins). */
  waitingSince: string | null;
  /**
   * The person the task belongs to, for a caller to turn into a name: whoever
   * raised it, else whoever is answerable for it, else its assignee. Null when
   * no person is on it (an agent-raised task) or when the task is not in the
   * list the rows were built from.
   */
  ownerUserId: string | null;
  /**
   * The task's own status, when the row came from a task the caller loaded —
   * what an inline status control has to edit. Null for a pending card whose
   * task is outside that list, where there is nothing to edit against.
   */
  status: string | null;
}

/**
 * Who owns the task. The originator first: on a desk of things waiting on a
 * person, "whose ask is this?" is the question a name answers. `responsibleUserId`
 * and the assignee are fallbacks for work an agent raised but a person owns.
 */
function ownerUserIdOf(issue: ReviewIssue): string | null {
  return issue.createdByUserId ?? issue.responsibleUserId ?? issue.assigneeUserId ?? null;
}

/** Interaction detail kinds that ask a person a question. */
const QUESTION_DETAIL_KINDS = new Set(["questions"]);

/**
 * Interaction detail kinds that ask a person to confirm something. Plan
 * approvals, checkbox confirmations and item verdicts are all confirmations
 * wearing different payloads: each one waits for a yes/no from a human.
 *
 * `suggested_tasks` is deliberately absent — it offers work to pick up, and
 * nothing is stuck until someone does.
 */
const CONFIRMATION_DETAIL_KINDS = new Set([
  "confirmation",
  "checkbox_confirmation",
  "item_verdicts",
  "plan_approval",
]);

/** Review paths that a person has to close out. */
const HUMAN_REVIEW_PATH_KINDS = new Set(["human_reviewer", "interaction", "approval"]);

type ReviewIssue = Pick<Issue, "id" | "status" | "title" | "updatedAt"> & {
  identifier?: string | null;
  parentId?: string | null;
  hiddenAt?: Date | string | null;
  harnessKind?: string | null;
  conversationAgentId?: string | null;
  createdByUserId?: string | null;
  responsibleUserId?: string | null;
  assigneeUserId?: string | null;
  completedAt?: Date | string | null;
  archivedAt?: Date | string | null;
  reviewAttention?: { state?: string | null; paths?: ReadonlyArray<{ kind?: string | null }> } | null;
};

/**
 * Is this interaction row waiting on a person?
 *
 * A card addressed to a named agent is that agent's to answer, so it does not
 * belong on a human's desk. Everything else can be answered by a person: all
 * three canonical resolver policies (`anyone`, `not_creator`, `human_only`)
 * admit the board, and a card addressed to a user obviously does.
 */
function awaitsPerson(item: AttentionItem): boolean {
  const audience = item.resolverAudience;
  if (!audience) return true;
  if (audience.addresseeUserId) return true;
  if (audience.addresseeAgentId && audience.effectiveResolverPolicy !== "human_only") return false;
  return true;
}

/** Rows the user has already parked: dismissed, snoozed, archived. */
function isParked(item: AttentionItem, now: number): boolean {
  if (item.dismissal?.dismissedAt) return true;
  if (item.archivedAt) return true;
  return Boolean(item.snoozedUntil && Date.parse(item.snoozedUntil) > now);
}

function interactionReason(item: AttentionItem): WaitingReason | null {
  const kind = item.detail?.kind;
  if (!kind) return null;
  if (QUESTION_DETAIL_KINDS.has(kind)) return "question";
  if (CONFIRMATION_DETAIL_KINDS.has(kind)) return "confirmation";
  return null;
}

/**
 * An `in_review` task counts when nothing but a person can move it: a named
 * reviewer, a pending card, an approval — or a review that has stalled with no
 * path at all. A review being carried by an agent run, a monitor or a queued
 * wake is progressing on its own and stays off the desk.
 */
function reviewAwaitsPerson(issue: ReviewIssue): boolean {
  if (issue.status !== "in_review") return false;
  const paths = issue.reviewAttention?.paths ?? [];
  if (paths.length === 0) return true;
  return paths.some((path) => path.kind != null && HUMAN_REVIEW_PATH_KINDS.has(path.kind));
}

/**
 * An agent marking a task `done` is a claim, not a sign-off: `human_approved`
 * is the status that records a person agreed. So every `done` task is still on
 * someone's desk, and `human_approved` and `cancelled` are not.
 */
function doneAwaitsApproval(issue: ReviewIssue): boolean {
  return issue.status === "done";
}

const REASON_ORDER: WaitingReason[] = ["question", "confirmation", "in_review", "done_unapproved"];

function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

interface Draft extends WaitingOnHumanRow {
  reasonSet: Set<WaitingReason>;
}

/**
 * Build the widget's rows. Oldest wait first: the whole point of the list is to
 * show what has been sitting the longest, so a three-day-old question outranks
 * a review that arrived a minute ago.
 */
export function waitingOnHumanRows(
  items: readonly AttentionItem[],
  issues: readonly ReviewIssue[],
  now = Date.now(),
): WaitingOnHumanRow[] {
  const drafts = new Map<string, Draft>();

  // Which task ids are subtasks, and which are not board-visible work. A feed
  // row carries neither fact of its own, so its task is looked up here; a card
  // on a task the list does not cover (an older task, or one past the list's
  // page) stays in — an unknown parent is no reason to drop a decision nobody
  // has made. Note that an absent task cannot be assumed hidden: the list
  // endpoint omits hidden tasks entirely, which is why the feed itself has to
  // drop their cards rather than this filter inferring it.
  const childIssueIds = new Set(
    issues.filter((issue) => issue.parentId != null).map((issue) => issue.id),
  );
  const invisibleIssueIds = new Set(
    issues.filter((issue) => !isVisibleWorkTask(issue)).map((issue) => issue.id),
  );

  const issueById = new Map(issues.map((issue) => [issue.id, issue]));

  const merge = (input: {
    key: string;
    issueId: string | null;
    identifier: string | null;
    title: string;
    href: string | null;
    reason: WaitingReason;
    detail: string | null;
    waitingSince: string | null;
    ownerUserId: string | null;
    status: string | null;
  }) => {
    const existing = drafts.get(input.key);
    if (!existing) {
      drafts.set(input.key, {
        key: input.key,
        issueId: input.issueId,
        identifier: input.identifier,
        title: input.title,
        href: input.href,
        reasons: [],
        reasonSet: new Set([input.reason]),
        detail: input.detail,
        waitingSince: input.waitingSince,
        ownerUserId: input.ownerUserId,
        status: input.status,
      });
      return;
    }
    existing.reasonSet.add(input.reason);
    existing.detail = existing.detail ?? input.detail;
    existing.href = existing.href ?? input.href;
    existing.identifier = existing.identifier ?? input.identifier;
    existing.ownerUserId = existing.ownerUserId ?? input.ownerUserId;
    existing.status = existing.status ?? input.status;
    existing.waitingSince = earlier(existing.waitingSince, input.waitingSince);
  };

  for (const item of items) {
    if (item.sourceKind !== "issue_thread_interaction") continue;
    if (isParked(item, now)) continue;
    if (!awaitsPerson(item)) continue;
    const reason = interactionReason(item);
    if (!reason) continue;
    const task = attentionTaskRef(item);
    const issueId = item.relatedIssue?.kind === "issue" ? item.relatedIssue.id : null;
    if (issueId && (childIssueIds.has(issueId) || invisibleIssueIds.has(issueId))) continue;
    merge({
      // Keyed on the task where there is one, so a second card on the same task
      // folds into its row instead of listing it twice.
      key: issueId ?? task?.identifier ?? item.dedupKey,
      issueId,
      identifier: task?.identifier ?? null,
      title: item.relatedIssue?.title ?? item.subject.title ?? task?.identifier ?? "Untitled task",
      href: task?.href ?? item.subject.href ?? null,
      reason,
      detail: attentionDetailLine(item),
      waitingSince: item.activityAt ?? item.createdAt ?? null,
      // A feed row carries no parentage or ownership of its own; both come
      // from the task it points at, when the list covers it.
      ownerUserId: issueId ? ownerUserIdOf(issueById.get(issueId) ?? {} as ReviewIssue) : null,
      status: (issueId ? issueById.get(issueId)?.status : null) ?? null,
    });
  }

  for (const issue of issues) {
    if (issue.parentId != null) continue;
    if (!isVisibleWorkTask(issue)) continue;
    const reason: WaitingReason | null = reviewAwaitsPerson(issue)
      ? "in_review"
      : doneAwaitsApproval(issue)
        ? "done_unapproved"
        : null;
    if (!reason) continue;
    // A finished task has been waiting since it finished, not since its last
    // edit — a comment on it does not restart the clock on the sign-off.
    const since = reason === "done_unapproved" ? issue.completedAt ?? issue.updatedAt : issue.updatedAt;
    merge({
      key: issue.id,
      issueId: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      href: `/issues/${issue.identifier ?? issue.id}`,
      reason,
      detail: null,
      waitingSince: since ? new Date(since).toISOString() : null,
      ownerUserId: ownerUserIdOf(issue),
      status: issue.status,
    });
  }

  return [...drafts.values()]
    .map(({ reasonSet, ...row }) => ({
      ...row,
      reasons: REASON_ORDER.filter((reason) => reasonSet.has(reason)),
    }))
    .sort((a, b) => {
      const at = a.waitingSince ? Date.parse(a.waitingSince) : Number.MAX_SAFE_INTEGER;
      const bt = b.waitingSince ? Date.parse(b.waitingSince) : Number.MAX_SAFE_INTEGER;
      return at - bt;
    });
}
