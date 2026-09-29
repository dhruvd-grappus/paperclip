import type { AttentionItem } from "./types/attention.js";

/**
 * The task a row belongs to, wherever the feed happens to put it.
 *
 * The feed uses two shapes, and a row that reads only one of them silently
 * drops the task key on the other:
 *   • the subject IS the task (review, blocked dependency) → `subject`
 *     carries the identifier and `relatedIssue` is null;
 *   • the subject hangs off a task (a thread interaction, an issue-scoped
 *     approval) → the task arrives separately as `relatedIssue`.
 *
 * `relatedIssue` wins when both are present: it is the *other* record, so it
 * is the one the subject alone can't tell you about.
 *
 * Returns null for rows genuinely not attached to a task — a hire approval, an
 * agent error — which should show no key rather than a borrowed one.
 *
 * Known gap (server-side, not resolvable here): an approval can carry
 * `subject.metadata.issueId` while `relatedIssue` is null. That is a bare UUID
 * with no key or href, so there is nothing to render; the feed builder has to
 * populate `relatedIssue` for those.
 */
export function attentionTaskRef(item: AttentionItem): { identifier: string; href: string | null } | null {
  const related = item.relatedIssue;
  if (related?.identifier) {
    return { identifier: related.identifier, href: related.href };
  }
  const subject = item.subject;
  if (subject.kind === "issue" && subject.identifier) {
    return { identifier: subject.identifier, href: subject.href };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Richer detail line (PAP-13409 §7) — render T1's structured `detail` block into
// a single secondary line under the title (the caller clamps it to 2 lines).
// ---------------------------------------------------------------------------

function quote(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return `“${trimmed}”`;
}

function countNoun(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * A concise human-readable detail line for a row, e.g.
 *   "2 questions — “Which auth provider…”"
 *   "Deploy failed — “exit code 1 on migrate”".
 * Returns `null` when the detail carries nothing beyond the title, so the row
 * can fall back to `whyNow`.
 */
export function attentionDetailLine(item: AttentionItem): string | null {
  const detail = item.detail;
  if (!detail) return null;
  switch (detail.kind) {
    case "plan_approval":
      return detail.planTitle?.trim() || quote(detail.summaryExcerpt);
    case "approval":
      return quote(detail.summaryExcerpt);
    case "confirmation":
      return quote(detail.promptExcerpt);
    case "checkbox_confirmation": {
      const q = quote(detail.promptExcerpt);
      return q ? `${countNoun(detail.optionCount, "option")} — ${q}` : countNoun(detail.optionCount, "option");
    }
    case "questions": {
      const q = quote(detail.firstQuestionText);
      const label = countNoun(detail.questionCount, "question");
      return q ? `${label} — ${q}` : label;
    }
    case "suggested_tasks": {
      const q = quote(detail.firstTaskTitle);
      const label = countNoun(detail.taskCount, "suggested task");
      return q ? `${label} — ${q}` : label;
    }
    case "item_verdicts": {
      const q = quote(detail.promptExcerpt);
      const label = `${countNoun(detail.itemCount, "item")} to verdict`;
      return q ? `${label} — ${q}` : label;
    }
    case "failed_run":
    case "agent_error": {
      const reason = quote(detail.failureReasonExcerpt);
      if (detail.agentName && reason) return `${detail.agentName} — ${reason}`;
      return detail.agentName ?? reason;
    }
    case "blocker": {
      const b = detail.blockingIssue;
      if (!b) return null;
      const id = b.identifier ? `${b.identifier} ` : "";
      return b.title ? `Blocked by ${id}${b.title}` : b.identifier ? `Blocked by ${b.identifier}` : null;
    }
    case "budget":
      return `${Math.round(detail.observedPercent)}% of budget used ($${detail.amountObserved} / $${detail.amountLimit})`;
    case "generic":
      return quote(detail.summaryExcerpt);
    default:
      return null;
  }
}

