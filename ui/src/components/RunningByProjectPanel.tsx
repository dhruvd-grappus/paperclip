import type { Issue, Project } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { StatusIcon } from "./StatusIcon";
import { timeAgo } from "../lib/timeAgo";
import { runningTasksByProject } from "../lib/dashboard-task-metrics";

/**
 * Dashboard: tasks running now (in progress, or with a live agent run),
 * grouped by project. A pulsing dot marks tasks an agent is executing.
 */
export function RunningByProjectPanel({
  issues,
  projects,
  liveIssueIds,
}: {
  issues: readonly Issue[];
  projects: readonly Pick<Project, "id" | "name">[];
  liveIssueIds: ReadonlySet<string>;
}) {
  const groups = runningTasksByProject(issues, liveIssueIds);
  const projectName = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <div className="min-w-0" data-testid="dashboard-running-by-project">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Running now, by project
      </h3>
      {groups.length === 0 ? (
        <Card className="block p-4">
          <p className="text-sm text-muted-foreground">Nothing running right now.</p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => {
            const liveCount = group.issues.filter((issue) => issue.live).length;
            return (
              <Card key={group.projectId ?? "none"} className="block py-0 overflow-hidden">
                <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
                  {group.projectId ? (
                    <Link to={`/projects/${group.projectId}`} className="truncate text-sm font-medium text-foreground no-underline hover:underline">
                      {projectName.get(group.projectId) ?? "Unknown project"}
                    </Link>
                  ) : (
                    <span className="truncate text-sm font-medium text-muted-foreground">No project</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {group.issues.length} running{liveCount > 0 ? ` · ${liveCount} live` : ""}
                  </span>
                </div>
                <div className="divide-y divide-border">
                  {group.issues.slice(0, 6).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm no-underline text-inherit hover:bg-accent/50"
                    >
                      {issue.live ? (
                        <span className="relative flex size-2 shrink-0" aria-label="agent running">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 motion-safe:animate-ping" />
                          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                        </span>
                      ) : (
                        <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                      )}
                      <span className="min-w-0 flex-1 truncate" title={issue.title}>{issue.title}</span>
                      <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
                        {issue.identifier ?? issue.id.slice(0, 8)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(issue.updatedAt)}</span>
                    </Link>
                  ))}
                  {group.issues.length > 6 ? (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">+{group.issues.length - 6} more</p>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
