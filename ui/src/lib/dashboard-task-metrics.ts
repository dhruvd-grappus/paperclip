import type { Issue } from "@paperclipai/shared";

type IssueLike = Pick<Issue, "id" | "status" | "projectId" | "updatedAt" | "completedAt"> & {
  description?: string | null;
  blockerAttention?: { state?: string | null } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a done issue finished: completedAt, else its last update. */
function doneAt(issue: IssueLike): number | null {
  if (issue.status !== "done") return null;
  const at = Date.parse(String(issue.completedAt ?? issue.updatedAt));
  return Number.isFinite(at) ? at : null;
}

export interface DashboardTaskMetrics {
  doneLast7Days: number;
  doneTotal: number;
  inProgress: number;
  open: number;
  blocked: number;
  blockedNeedingAttention: number;
}

export function dashboardTaskMetrics(issues: readonly IssueLike[], now = Date.now()): DashboardTaskMetrics {
  const metrics: DashboardTaskMetrics = {
    doneLast7Days: 0, doneTotal: 0, inProgress: 0, open: 0, blocked: 0, blockedNeedingAttention: 0,
  };
  for (const issue of issues) {
    const at = doneAt(issue);
    if (at !== null) {
      metrics.doneTotal += 1;
      if (now - at <= 7 * DAY_MS) metrics.doneLast7Days += 1;
    }
    if (issue.status === "in_progress") metrics.inProgress += 1;
    if (!["done", "cancelled"].includes(issue.status)) metrics.open += 1;
    if (issue.status === "blocked") {
      metrics.blocked += 1;
      if (issue.blockerAttention?.state === "needs_attention") metrics.blockedNeedingAttention += 1;
    }
  }
  return metrics;
}

/**
 * Project of an issue. Slack-bound issues carry no projectId (it would force a
 * managed worktree, see dev-pipe gotcha 30); scoping writes the project as a
 * "Project: <name> (<uuid>)" description line instead.
 */
export function issueProjectId(issue: IssueLike): string | null {
  if (issue.projectId) return issue.projectId;
  const match = issue.description?.match(/^Project: .*\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\s*$/m);
  return match ? match[1] : null;
}

export interface RunningProjectGroup<T> {
  projectId: string | null;
  issues: Array<T & { live: boolean }>;
}

/**
 * Tasks running now, grouped by project: in progress, or with a live agent run.
 * Groups with a live run come first, then by size; "no project" last.
 */
export function runningTasksByProject<T extends IssueLike>(
  issues: readonly T[],
  liveIssueIds: ReadonlySet<string>,
): RunningProjectGroup<T>[] {
  const groups = new Map<string | null, Array<T & { live: boolean }>>();
  for (const issue of issues) {
    const live = liveIssueIds.has(issue.id);
    if (!live && issue.status !== "in_progress") continue;
    const projectId = issueProjectId(issue);
    const list = groups.get(projectId) ?? [];
    list.push({ ...issue, live });
    groups.set(projectId, list);
  }
  const order = (group: RunningProjectGroup<T>) => [
    group.projectId === null ? 1 : 0,
    group.issues.some((issue) => issue.live) ? 0 : 1,
    -group.issues.length,
  ];
  return [...groups.entries()]
    .map(([projectId, list]) => ({
      projectId,
      issues: list.sort((a, b) => Number(b.live) - Number(a.live) || Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt))),
    }))
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    });
}

type InterventionIssue = IssueLike & Pick<Issue, "createdByUserId" | "createdByAgentId"> & { originKind?: string | null };

/** Started by a person: created by a user (UI, Slack), not by an agent. */
export function isPersonStarted(issue: InterventionIssue): boolean {
  return issue.originKind === "chat_channel" || (Boolean(issue.createdByUserId) && !issue.createdByAgentId);
}

/**
 * "Human Intervention Needed": tasks people started that are blocked right
 * now, longest waiting first.
 */
export function humanInterventionNeeded<T extends InterventionIssue>(issues: readonly T[]): T[] {
  return issues
    .filter((issue) => issue.status === "blocked" && isPersonStarted(issue))
    .sort((a, b) => Date.parse(String(a.updatedAt)) - Date.parse(String(b.updatedAt)));
}
