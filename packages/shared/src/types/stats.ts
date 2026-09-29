/**
 * Delivery statistics for the Stats page.
 *
 * Vocabulary shared by every field below:
 * - "task" means a parent task (`issues.parent_id IS NULL`). The only exception is
 *   {@link StatsTaskExtreme}, which ranks issues at any level.
 * - a task counts as completed when its status is `done` and its `completed_at`
 *   falls inside the requested range. Cancelled, hidden and harness issues never count.
 * - every duration is milliseconds, every day bucket is a UTC calendar day.
 */

export interface StatsRange {
  from: string;
  to: string;
}

export interface StatsTimeBurnDay {
  /** UTC calendar day, `YYYY-MM-DD` */
  date: string;
  /** summed run wall-clock of the runs that finished that day */
  ms: number;
  runCount: number;
}

/** Agent time spent, bucketed by the day each heartbeat run finished. */
export interface StatsTimeBurn {
  totalMs: number;
  /** totalMs divided by the number of calendar days in the range */
  avgMsPerDay: number;
  /** same average over the equally long range immediately before this one */
  previousAvgMsPerDay: number;
  /** one entry per calendar day in the range, quiet days included as zero */
  days: StatsTimeBurnDay[];
}

export interface StatsParentTaskDurations {
  doneCount: number;
  avgDurationMs: number;
  medianDurationMs: number;
  /** completed tasks with no usable start/finish clock, excluded from the averages */
  notMeasurableCount: number;
}

export interface StatsTaskExtreme {
  issueId: string;
  identifier: string | null;
  title: string;
  projectId: string | null;
  durationMs: number;
}

export interface StatsThroughputDay {
  /** UTC calendar day, `YYYY-MM-DD` */
  date: string;
  count: number;
}

export interface StatsThroughput {
  /** one entry per calendar day in the range, quiet days included as zero */
  donePerDay: StatsThroughputDay[];
  /** tasks in progress or in review right now, not range-bound */
  wipCount: number;
  /** tasks blocked right now, not range-bound */
  blockedCount: number;
}

export interface StatsOverview {
  range: StatsRange;
  timeBurn: StatsTimeBurn;
  parentTasks: StatsParentTaskDurations;
  /** null when the range holds no measurable task */
  fastestTask: StatsTaskExtreme | null;
  slowestTask: StatsTaskExtreme | null;
  throughput: StatsThroughput;
}

export interface StatsProjectPerformance {
  projectId: string;
  name: string;
  doneCount: number;
  avgDurationMs: number;
  medianDurationMs: number;
  /** agent run time attributed to the project through the run's issue */
  timeSpentMs: number;
  spendCents: number;
  /** spendCents / doneCount, 0 when nothing completed */
  costPerDoneTaskCents: number;
}

export interface StatsByProject {
  projects: StatsProjectPerformance[];
}

/** Rolling lookback windows the token-usage view reports. */
export type StatsTokenWindowKey = "1d" | "5d" | "7d" | "30d";

export interface StatsTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** input + cached input + output */
  totalTokens: number;
  costCents: number;
  runCount: number;
}

export interface StatsTokenAgentUsage extends StatsTokenTotals {
  agentId: string;
  agentName: string;
}

/**
 * Tokens one cloud login served. `accountLabel` is the login's email; null groups
 * the events recorded before accounts were tracked, or by providers without one.
 */
export interface StatsTokenAccountUsage extends StatsTokenTotals {
  accountLabel: string | null;
  provider: string;
  /** every agent that used this account in the window, largest first */
  agents: StatsTokenAgentUsage[];
}

export interface StatsTokenWindow {
  window: StatsTokenWindowKey;
  hours: number;
  since: string;
  totals: StatsTokenTotals;
  /** per account, largest first */
  accounts: StatsTokenAccountUsage[];
  /** per agent across all accounts, largest first */
  agents: StatsTokenAgentUsage[];
}

export interface StatsTokenUsage {
  generatedAt: string;
  /** the login the server's runs currently inherit, null when unknown */
  activeAccountLabel: string | null;
  windows: StatsTokenWindow[];
}
