import { useMemo } from "react";
import type { AttentionItem, Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { StatusGlyph } from "./StatusGlyph";
import { timeAgo } from "../lib/timeAgo";
import { waitingOnHumanRows, waitingReasonLabel, type WaitingReason } from "../lib/waiting-on-human";

/** How many rows the widget shows before collapsing into a "+N more" line. */
const VISIBLE_ROWS = 8;

/**
 * The glyph borrows the task status a reason renders as, so the vocabulary
 * matches the task list and the decision queue (see `lib/attention.ts`):
 * a pending card is a task stopped on a decision, a review is `in_review`.
 */
function glyphStatus(reasons: readonly WaitingReason[]): "in_review" | "blocked" {
  return reasons.every((reason) => reason === "in_review") ? "in_review" : "blocked";
}

/**
 * Dashboard: "Waiting on you" — every task whose next move is a person's,
 * oldest wait first. Pending questions, pending confirmations, and tasks parked
 * in review. See `lib/waiting-on-human` for what qualifies and why.
 *
 * Distinct from the Human Intervention panel next to it: that one lists
 * `blocked` tasks a person *started*, regardless of who unblocks them; this one
 * lists tasks of any origin that cannot move until a human answers.
 */
export function WaitingOnYouPanel({
  attentionItems,
  issues,
}: {
  attentionItems: readonly AttentionItem[];
  issues: readonly Issue[];
}) {
  const rows = useMemo(() => waitingOnHumanRows(attentionItems, issues), [attentionItems, issues]);

  return (
    <div className="min-w-0" data-testid="dashboard-waiting-on-you">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Waiting On You{rows.length > 0 ? ` · ${rows.length}` : ""}
      </h3>
      {rows.length === 0 ? (
        <Card className="block p-4">
          <p className="text-sm text-muted-foreground">
            No task is waiting on a person — no open questions, confirmations, or reviews.
          </p>
        </Card>
      ) : (
        <Card className="@container block py-0 divide-y divide-border overflow-hidden border-violet-500/30">
          {rows.slice(0, VISIBLE_ROWS).map((row) => {
            const reasons = row.reasons.map(waitingReasonLabel).join(" · ");
            const waiting = row.waitingSince ? `waiting ${timeAgo(row.waitingSince)}` : null;
            const secondary = [reasons, row.detail, waiting].filter(Boolean).join(" · ");
            const body = (
              <>
                <StatusGlyph status={glyphStatus(row.reasons)} className="shrink-0" />
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
          {rows.length > VISIBLE_ROWS ? (
            <Link
              // Not `/decisions`: that surface is behind an experimental flag,
              // so the task list is the link every board user can follow.
              to="/issues"
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
