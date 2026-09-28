import { useMemo } from "react";
import type { AttentionItem, Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { StatusGlyph } from "./StatusGlyph";
import { StatusIcon } from "./StatusIcon";
import { timeAgo } from "../lib/timeAgo";
import { waitingOnHumanRows, waitingReasonLabel, type WaitingReason } from "../lib/waiting-on-human";

/** How many rows the widget shows before collapsing into a "+N more" line. */
const VISIBLE_ROWS = 8;

/**
 * The glyph borrows the task status a reason renders as, so the vocabulary
 * matches the task list and the decision queue (see `lib/attention.ts`):
 * a pending card is a task stopped on a decision, a review is `in_review`, a
 * task awaiting sign-off is `done`. A row carrying a pending card shows the
 * decision glyph even when it is also in review or finished — the card is the
 * part that cannot move.
 */
function glyphStatus(reasons: readonly WaitingReason[]): "in_review" | "done" | "blocked" {
  if (reasons.every((reason) => reason === "in_review")) return "in_review";
  if (reasons.every((reason) => reason === "done_unapproved")) return "done";
  return "blocked";
}

/**
 * Dashboard: "Waiting on you" — every parent task whose next move is a
 * person's, oldest wait first. Pending questions, pending confirmations, tasks
 * parked in review, and tasks marked `done` that nobody has approved yet. See
 * `lib/waiting-on-human` for what qualifies and why.
 *
 * The dashboard shows the first {@link VISIBLE_ROWS} and links the rest to
 * `/waiting-on-you`, which renders this same component with `showAll` — one
 * definition of the list, two lengths, so the page can never disagree with the
 * card that sent you there.
 *
 * Distinct from the Human Intervention panel next to it: that one lists
 * `blocked` tasks a person *started*, regardless of who unblocks them; this one
 * lists tasks of any origin that cannot move until a human answers.
 */
export function WaitingOnYouPanel({
  attentionItems,
  issues,
  userName,
  onUpdateIssue,
  showAll = false,
  showHeading = true,
}: {
  attentionItems: readonly AttentionItem[];
  issues: readonly Issue[];
  /** Resolves a row's owner id to a name; omitted, rows show no owner. */
  userName?: (userId: string | null | undefined) => string | null;
  /**
   * Given, each row whose task status is known becomes an inline status
   * picker, so a review can be approved or a question closed out from the desk
   * without opening the task. Omitted, rows keep the read-only reason glyph.
   */
  onUpdateIssue?: (issueId: string, data: { status: string }) => void;
  /** Render every row instead of collapsing into a "+N more" link. */
  showAll?: boolean;
  showHeading?: boolean;
}) {
  const rows = useMemo(() => waitingOnHumanRows(attentionItems, issues), [attentionItems, issues]);
  const visibleRows = showAll ? rows : rows.slice(0, VISIBLE_ROWS);

  return (
    <div className="min-w-0" data-testid="dashboard-waiting-on-you">
      {showHeading ? (
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Waiting On You{rows.length > 0 ? ` · ${rows.length}` : ""}
        </h3>
      ) : null}
      {rows.length === 0 ? (
        <Card className="block p-4">
          <p className="text-sm text-muted-foreground">
            No task is waiting on a person — no open questions, confirmations, reviews, or
            finished work to approve.
          </p>
        </Card>
      ) : (
        <Card className="@container block py-0 divide-y divide-border overflow-hidden border-violet-500/30">
          {visibleRows.map((row) => {
            const reasons = row.reasons.map(waitingReasonLabel).join(" · ");
            const waiting = row.waitingSince ? `waiting ${timeAgo(row.waitingSince)}` : null;
            const owner = userName?.(row.ownerUserId) ?? null;
            const secondary = [reasons, owner ? `owner ${owner}` : null, row.detail, waiting]
              .filter(Boolean)
              .join(" · ");
            // The picker edits the task's real status, so it only appears when
            // the row came from a loaded task. A pending card on a task outside
            // the list keeps the reason glyph: there is nothing to edit.
            const editable = onUpdateIssue && row.issueId && row.status;
            const body = (
              <>
                {editable ? (
                  <span
                    className="shrink-0"
                    // The row is a link to the task; the picker inside it is not.
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    <StatusIcon
                      status={row.status!}
                      size="md"
                      onChange={(status) => onUpdateIssue!(row.issueId!, { status })}
                    />
                  </span>
                ) : (
                  <StatusGlyph status={glyphStatus(row.reasons)} className="shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={row.title}>{row.title}</span>
                  <span className="block truncate text-xs text-muted-foreground" title={secondary}>
                    {secondary}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
                  {row.identifier ?? row.issueId?.slice(0, 8) ?? ""}
                </span>
              </>
            );
            const className = "flex items-center gap-2 px-3 py-2 text-sm no-underline text-inherit hover:bg-accent/50";
            // A row with no task link still belongs in the list — its count is
            // the signal — so it renders as plain text rather than a dead link.
            return row.href ? (
              <Link key={row.key} to={row.href} className={className}>
                {body}
              </Link>
            ) : (
              <div key={row.key} className={className}>
                {body}
              </div>
            );
          })}
          {!showAll && rows.length > VISIBLE_ROWS ? (
            <Link
              // The full list, not `/issues`: half of these rows are pending
              // cards that no task-list filter can express.
              to="/waiting-on-you"
              className="block px-3 py-1.5 text-xs text-muted-foreground no-underline hover:bg-accent/50"
            >
              +{rows.length - VISIBLE_ROWS} more
            </Link>
          ) : null}
        </Card>
      )}
    </div>
  );
}
