import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { StatusIcon } from "./StatusIcon";
import { timeAgo } from "../lib/timeAgo";
import { humanInterventionNeeded } from "../lib/dashboard-task-metrics";

/**
 * Dashboard: tasks a person started (UI or Slack) that are blocked right now,
 * longest waiting first. These usually need someone to answer, unblock, or
 * cancel them.
 */
export function HumanInterventionPanel({
  issues,
  userName,
  onUpdateIssue,
}: {
  issues: readonly Issue[];
  userName: (userId: string | null | undefined) => string | null;
  /**
   * Given, the row's status icon becomes a picker — a blocked task can be
   * cancelled or pushed back to `todo` from here, which is usually the whole
   * decision, without opening it.
   */
  onUpdateIssue?: (issueId: string, data: { status: string }) => void;
}) {
  const needed = humanInterventionNeeded(issues as Array<Issue & { originKind?: string | null }>);

  return (
    <div className="min-w-0" data-testid="dashboard-human-intervention">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Human Intervention Needed{needed.length > 0 ? ` · ${needed.length}` : ""}
      </h3>
      {needed.length === 0 ? (
        <Card className="block p-4">
          <p className="text-sm text-muted-foreground">No task started by a person is blocked.</p>
        </Card>
      ) : (
        <Card className="@container block py-0 divide-y divide-border overflow-hidden border-amber-500/30">
          {needed.slice(0, 8).map((issue) => {
            const by = userName(issue.createdByUserId);
            const stuckOn = issue.blockerAttention?.sampleBlockerIdentifier;
            return (
              <div
                key={issue.id}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50"
              >
                {/*
                  * Beside the link, not inside it: a popover trigger nested in
                  * an anchor is invalid markup and the anchor wins the click.
                  */}
                <StatusIcon
                  status={issue.status}
                  blockerAttention={issue.blockerAttention}
                  onChange={onUpdateIssue ? (status) => onUpdateIssue(issue.id, { status }) : undefined}
                />
                <Link
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="flex min-w-0 flex-1 items-center gap-2 text-sm no-underline text-inherit"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate" title={issue.title}>{issue.title}</span>
                      <span className="shrink-0 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-(length:--text-micro) font-medium leading-4 text-red-700 dark:text-red-300">
                        Blocked
                      </span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[by ? `started by ${by}` : null, stuckOn ? `waiting on ${stuckOn}` : null, `blocked ${timeAgo(issue.updatedAt)}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                </Link>
              </div>
            );
          })}
          {needed.length > 8 ? (
            <p className="px-3 py-1.5 text-xs text-muted-foreground">+{needed.length - 8} more</p>
          ) : null}
        </Card>
      )}
    </div>
  );
}
