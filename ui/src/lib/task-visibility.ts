/**
 * Which tasks belong on a board surface.
 *
 * The server already answers this for every queue and count it computes
 * (`server/src/services/issue-visibility.ts`): a task is visible when it is
 * not hidden and not harness scaffolding, and work queues additionally drop
 * persistent conversation containers, which are chat threads wearing a task
 * row rather than work anybody does.
 *
 * The company task list endpoint does *not* apply that filter — it returns
 * `hiddenAt` and `harnessKind` as fields and leaves the decision to the
 * caller. So any dashboard panel or metric derived from that list has to apply
 * the rule itself, or it shows rows the rest of the product treats as absent
 * and reports counts the server's own summary disagrees with.
 */

export interface VisibilityFields {
  hiddenAt?: Date | string | null;
  harnessKind?: string | null;
  conversationAgentId?: string | null;
  archivedAt?: Date | string | null;
}

/** Mirrors the server's `visibleIssueCondition`, plus archived. */
export function isVisibleTask(issue: VisibilityFields): boolean {
  if (issue.hiddenAt) return false;
  if (issue.harnessKind) return false;
  if (issue.archivedAt) return false;
  return true;
}

/**
 * Mirrors the server's `executionIssueCondition`: visible, and not a
 * persistent conversation container. This is the rule for anything that
 * counts or lists *work*.
 */
export function isVisibleWorkTask(issue: VisibilityFields): boolean {
  return isVisibleTask(issue) && !issue.conversationAgentId;
}

export function visibleWorkTasks<T extends VisibilityFields>(issues: readonly T[]): T[] {
  return issues.filter((issue) => isVisibleWorkTask(issue));
}
