import type { ReactNode } from "react";
import type { WaitingOnHumanRow, WaitingReason } from "@paperclipai/shared";
import { waitingReasonLabel } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { StatusGlyph } from "./StatusGlyph";
import { StatusIcon } from "./StatusIcon";
import { timeAgo } from "../lib/timeAgo";

/** How many rows the widget shows before collapsing into a "+N more" line. */
const VISIBLE_ROWS = 8;

/** One chip per wait reason, so the desk reads at a glance. */
const REASON_CHIP_CLASS: Record<WaitingReason, string> = {
  question: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  confirmation: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  in_review: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  done_unapproved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

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
 * `waiting-on-human` in `@paperclipai/shared` for what qualifies and why.
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
  rows,
  userName,
  projectName,
  onUpdateIssue,
  showAll = false,
  showHeading = true,
  filters,
  filtering = false,
  moreHref = "/waiting-on-you",
}: {
  /**
   * The rows, as the server built them (`GET /companies/:id/waiting-on-you`).
   * The panel no longer derives the list from the task list and the attention
   * feed: the rule runs where the data is, so the dashboard and the page show
   * the same rows without either one loading the whole company to do it.
   */
  rows: readonly WaitingOnHumanRow[];
  /** Resolves a row's owner id to a name; omitted, rows show no owner. */
  userName?: (userId: string | null | undefined) => string | null;
  /** Resolves a row's project id to a name for the group header ("No project" when null). */
  projectName?: (projectId: string | null | undefined) => string | null;
  /**
   * Given, each row whose task status is known becomes an inline status
   * picker, so a review can be approved or a question closed out from the desk
   * without opening the task. Omitted, rows keep the read-only reason glyph.
   */
  onUpdateIssue?: (issueId: string, data: { status: string }) => void;
  /** Render every row instead of collapsing into a "+N more" link. */
  showAll?: boolean;
  showHeading?: boolean;
  /**
   * The filter pickers, rendered beside the heading. A slot rather than props:
   * the panel renders rows and has no business knowing what a facet is, and the
   * dashboard and the page hand it the same pair from one hook
   * (`useWaitingOnYouFilters`), so the two surfaces filter identically.
   */
  filters?: ReactNode;
  /** Whether a filter is on, so the empty state says which emptiness this is. */
  filtering?: boolean;
  /**
   * Where "+N more" goes. The dashboard passes its current filters along in the
   * query string, so following the link keeps the list you were looking at.
   */
  moreHref?: string;
}) {
  const visibleRows = showAll ? rows : rows.slice(0, VISIBLE_ROWS);
  // Rows grouped by project, in the order the rows arrive (oldest wait first),
  // so the desk reads like "Running now, by project" does.
  const groups: Array<{ key: string; label: string; rows: WaitingOnHumanRow[] }> = [];
  const groupIndex = new Map<string, number>();
  for (const row of visibleRows) {
    const key = row.projectId ?? "__none__";
    let at = groupIndex.get(key);
    if (at === undefined) {
      at = groups.length;
      groupIndex.set(key, at);
      groups.push({
        key,
        label: projectName?.(row.projectId ?? null) ?? (row.projectId ? "Unknown project" : "No project"),
        rows: [],
      });
    }
    groups[at].rows.push(row);
  }

  return (
    <div className="min-w-0" data-testid="dashboard-waiting-on-you">
      {showHeading || filters ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {showHeading ? (
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Waiting On You{rows.length > 0 ? ` · ${rows.length}` : ""}
            </h3>
          ) : null}
          {filters ? <div className="flex flex-wrap items-center gap-2">{filters}</div> : null}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Card className="block p-4">
          <p className="text-sm text-muted-foreground">
            {filtering
              ? "No task waiting on a person matches these filters."
              : "No task is waiting on a person — no open questions, confirmations, reviews, or finished work to approve."}
          </p>
        </Card>
      ) : (
        <Card className="@container block py-0 divide-y divide-border overflow-hidden border-violet-500/30">
          {groups.map((group) => (
            <div key={group.key} className="divide-y divide-border">
              <div className="bg-muted/40 px-3 py-1 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label} · {group.rows.length}
              </div>
              {group.rows.map((row) => {
            const reasonChips = row.reasons.map((reason) => (
              <span
                key={reason}
                className={`shrink-0 rounded-full border px-2 py-0.5 text-(length:--text-micro) font-medium leading-4 ${REASON_CHIP_CLASS[reason]}`}
              >
                {waitingReasonLabel(reason)}
              </span>
            ));
            const waiting = row.waitingSince ? `waiting ${timeAgo(row.waitingSince)}` : null;
            const owner = userName?.(row.ownerUserId) ?? null;
            const secondary = [owner ? `owner ${owner}` : null, row.detail, waiting]
              .filter(Boolean)
              .join(" · ");
            // The picker edits the task's real status, so it only appears when
            // the row came from a loaded task. A pending card on a task outside
            // the list keeps the reason glyph: there is nothing to edit.
            const editable = onUpdateIssue && row.issueId && row.status;
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate" title={row.title}>{row.title}</span>
                    {reasonChips}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground" title={secondary}>
                    {secondary}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
                  {row.identifier ?? row.issueId?.slice(0, 8) ?? ""}
                </span>
              </>
            );
            const linkClassName = "flex min-w-0 flex-1 items-center gap-2 text-sm no-underline text-inherit";
            // The status control sits *beside* the row's link, not inside it: a
            // popover trigger nested in an anchor is invalid markup, and the
            // anchor wins the click, which is why the first attempt at inline
            // editing did nothing.
            return (
              <div
                key={row.key}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50"
              >
                {editable ? (
                  <StatusIcon
                    status={row.status!}
                    size="md"
                    onChange={(status) => onUpdateIssue!(row.issueId!, { status })}
                  />
                ) : (
                  <StatusGlyph status={glyphStatus(row.reasons)} className="shrink-0" />
                )}
                {/*
                  * A row with no task link still belongs in the list — its count
                  * is the signal — so it renders as plain text, not a dead link.
                  */}
                {row.href ? (
                  <Link to={row.href} className={linkClassName}>
                    {body}
                  </Link>
                ) : (
                  <div className={linkClassName}>{body}</div>
                )}
              </div>
            );
          })}
            </div>
          ))}
          {!showAll && rows.length > VISIBLE_ROWS ? (
            <Link
              // The full list, not `/issues`: half of these rows are pending
              // cards that no task-list filter can express.
              to={moreHref}
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
