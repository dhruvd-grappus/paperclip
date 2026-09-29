import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import type {
  StatsByProject,
  StatsOverview,
  StatsProjectPerformance,
  StatsTaskExtreme,
  StatsThroughputDay,
  StatsTimeBurnDay,
  StatsTokenAccountUsage,
  StatsTokenAgentUsage,
  StatsTokenTotals,
  StatsTokenUsage,
  StatsTokenWindow,
  StatsTokenWindowKey,
} from "@paperclipai/shared";
import { readActiveClaudeAccountLabel } from "./claude-account.js";

export interface StatsRangeInput {
  from?: Date;
  to?: Date;
}

export interface StatsOverviewInput extends StatsRangeInput {
  projectId?: string;
}

const DEFAULT_RANGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** A task is "in flight" from the moment an agent picks it up until it leaves review. */
const WIP_STATUSES = ["in_progress", "in_review"] as const;

export interface ResolvedStatsRange {
  from: Date;
  to: Date;
  /** UTC calendar days covered by the range, at least 1 */
  dayCount: number;
  /** first UTC day, `YYYY-MM-DD` */
  fromDay: string;
  /** last UTC day, `YYYY-MM-DD` */
  toDay: string;
}

function utcDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** Missing bounds mean "the last 30 days". */
export function resolveStatsRange(range?: StatsRangeInput): ResolvedStatsRange {
  const to = range?.to ?? new Date();
  const from = range?.from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);
  const fromDay = utcDay(from);
  const toDay = utcDay(to);
  const dayCount = Math.max(
    1,
    Math.round((Date.parse(`${toDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) / MS_PER_DAY) + 1,
  );
  return { from, to, dayCount, fromDay, toDay };
}

/**
 * A raw `sql` parameter carrying a JS Date is handed to the driver untranslated,
 * so pass instants as ISO text with an explicit cast instead.
 */
function ts(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMs(value: unknown) {
  return Math.round(num(value));
}

/** Only visible product issues count; harness bookkeeping, hidden and cancelled rows never do. */
function visibleIssues(): SQL {
  return sql`${issues.hiddenAt} is null and ${issues.harnessKind} is null and ${issues.cancelledAt} is null`;
}

/**
 * Wall-clock of a finished run, never negative: a finished_at before started_at is
 * a clock anomaly, not negative work.
 */
function runDurationMs(): SQL {
  return sql`greatest(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000, 0)`;
}

function finishedRunCondition(companyId: string, range: ResolvedStatsRange): SQL {
  return sql`${heartbeatRuns.companyId} = ${companyId}
    and ${heartbeatRuns.startedAt} is not null
    and ${heartbeatRuns.finishedAt} is not null
    and ${heartbeatRuns.finishedAt} >= ${ts(range.from)}
    and ${heartbeatRuns.finishedAt} <= ${ts(range.to)}`;
}

/** Measurable = both clocks present and in order. Anything else is not measurable. */
function measurableDurationMs(): SQL {
  return sql`case
      when ${issues.startedAt} is not null
       and ${issues.completedAt} is not null
       and ${issues.completedAt} >= ${issues.startedAt}
      then extract(epoch from (${issues.completedAt} - ${issues.startedAt})) * 1000
    end`;
}

function doneInRangeCondition(companyId: string, range: ResolvedStatsRange): SQL {
  return sql`${issues.companyId} = ${companyId}
    and ${visibleIssues()}
    and ${issues.status} = 'done'
    and ${issues.completedAt} >= ${ts(range.from)}
    and ${issues.completedAt} <= ${ts(range.to)}`;
}

function projectFilter(projectId?: string): SQL {
  return projectId ? sql` and ${issues.projectId} = ${projectId}` : sql.empty();
}

/** One row per UTC calendar day in the range, so a chart never has to guess a gap. */
function dayScaffold(range: ResolvedStatsRange): SQL {
  return sql`select generate_series(${range.fromDay}::date, ${range.toDay}::date, interval '1 day')::date as day`;
}

/** Lookback windows for the token-usage view, shortest first. */
export const TOKEN_USAGE_WINDOWS: ReadonlyArray<{ window: StatsTokenWindowKey; hours: number }> = [
  { window: "1d", hours: 24 },
  { window: "5d", hours: 5 * 24 },
  { window: "7d", hours: 7 * 24 },
  { window: "30d", hours: 30 * 24 },
];

interface TokenUsageRow {
  accountLabel: string | null;
  provider: string;
  agentId: string;
  agentName: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  runCount: number;
}

function emptyTokenTotals(): StatsTokenTotals {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0, runCount: 0 };
}

function addTokenTotals(target: StatsTokenTotals, row: TokenUsageRow) {
  target.inputTokens += row.inputTokens;
  target.cachedInputTokens += row.cachedInputTokens;
  target.outputTokens += row.outputTokens;
  target.totalTokens += row.inputTokens + row.cachedInputTokens + row.outputTokens;
  target.costCents += row.costCents;
  target.runCount += row.runCount;
}

function byTotalTokensDesc(a: StatsTokenTotals, b: StatsTokenTotals) {
  return b.totalTokens - a.totalTokens || b.costCents - a.costCents;
}

/**
 * Folds account × agent rows into one window: totals, per-account (with the agents
 * inside each account) and per-agent across accounts. Pure so it can be unit tested.
 */
export function foldTokenUsageWindow(
  window: StatsTokenWindowKey,
  hours: number,
  since: Date,
  rows: TokenUsageRow[],
): StatsTokenWindow {
  const totals = emptyTokenTotals();
  const accountMap = new Map<string, StatsTokenAccountUsage>();
  const agentMap = new Map<string, StatsTokenAgentUsage>();
  for (const row of rows) {
    addTokenTotals(totals, row);
    const accountKey = `${row.provider}\u0000${row.accountLabel ?? ""}`;
    let account = accountMap.get(accountKey);
    if (!account) {
      account = { ...emptyTokenTotals(), accountLabel: row.accountLabel, provider: row.provider, agents: [] };
      accountMap.set(accountKey, account);
    }
    addTokenTotals(account, row);
    account.agents.push({ ...emptyTokenTotals(), agentId: row.agentId, agentName: row.agentName });
    addTokenTotals(account.agents[account.agents.length - 1]!, row);
    let agent = agentMap.get(row.agentId);
    if (!agent) {
      agent = { ...emptyTokenTotals(), agentId: row.agentId, agentName: row.agentName };
      agentMap.set(row.agentId, agent);
    }
    addTokenTotals(agent, row);
  }
  const accounts = [...accountMap.values()].sort(byTotalTokensDesc);
  for (const account of accounts) account.agents.sort(byTotalTokensDesc);
  return {
    window,
    hours,
    since: since.toISOString(),
    totals,
    accounts,
    agents: [...agentMap.values()].sort(byTotalTokensDesc),
  };
}

export function statsService(db: Db) {
  async function timeBurn(companyId: string, range: ResolvedStatsRange, projectId?: string) {
    // A run belongs to the issue named on the row, or — for adapter-driven and older
    // runs — to the one in its indexed context snapshot.
    const runProjectFilter = projectId
      ? sql` and exists (
            select 1 from ${issues}
            where ${issues.companyId} = ${companyId}
              and ${issues.projectId} = ${projectId}
              and ${issues.id}::text = coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot} ->> 'issueId')
          )`
      : sql.empty();

    const daysSql = sql`
      with days as (${dayScaffold(range)}),
      runs as (
        select (${heartbeatRuns.finishedAt} at time zone 'UTC')::date as day,
               ${runDurationMs()} as ms
        from ${heartbeatRuns}
        where ${finishedRunCondition(companyId, range)}${runProjectFilter}
      )
      select to_char(days.day, 'YYYY-MM-DD') as "date",
             coalesce(sum(runs.ms), 0)::double precision as ms,
             count(runs.ms)::int as "runCount"
      from days left join runs on runs.day = days.day
      group by days.day
      order by days.day
    `;

    const previousFrom = new Date(range.from.getTime() - (range.to.getTime() - range.from.getTime()));
    const previousSql = sql`
      select coalesce(sum(${runDurationMs()}), 0)::double precision as ms
      from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${companyId}
        and ${heartbeatRuns.startedAt} is not null
        and ${heartbeatRuns.finishedAt} is not null
        and ${heartbeatRuns.finishedAt} >= ${ts(previousFrom)}
        and ${heartbeatRuns.finishedAt} < ${ts(range.from)}${runProjectFilter}
    `;

    const [dayResult, previousResult] = await Promise.all([db.execute(daysSql), db.execute(previousSql)]);

    const days: StatsTimeBurnDay[] = rowsOf<{ date: string; ms: unknown; runCount: unknown }>(dayResult).map((row) => ({
      date: row.date,
      ms: roundMs(row.ms),
      runCount: num(row.runCount),
    }));
    const totalMs = days.reduce((sum, day) => sum + day.ms, 0);
    const previousTotalMs = num(rowsOf<{ ms: unknown }>(previousResult)[0]?.ms);

    return {
      totalMs,
      avgMsPerDay: Math.round(totalMs / range.dayCount),
      previousAvgMsPerDay: Math.round(previousTotalMs / range.dayCount),
      days,
    };
  }

  async function parentTaskDurations(companyId: string, range: ResolvedStatsRange, projectId?: string) {
    const statement = sql`
      with done as (
        select ${measurableDurationMs()} as ms
        from ${issues}
        where ${doneInRangeCondition(companyId, range)}
          and ${issues.parentId} is null${projectFilter(projectId)}
      )
      select count(*)::int as "doneCount",
             count(ms)::int as "measurableCount",
             coalesce(avg(ms) filter (where ms is not null), 0)::double precision as "avgDurationMs",
             coalesce(
               percentile_cont(0.5) within group (order by ms) filter (where ms is not null),
               0
             )::double precision as "medianDurationMs"
      from done
    `;
    const row = rowsOf<{
      doneCount: unknown;
      measurableCount: unknown;
      avgDurationMs: unknown;
      medianDurationMs: unknown;
    }>(await db.execute(statement))[0];
    const doneCount = num(row?.doneCount);
    return {
      doneCount,
      avgDurationMs: roundMs(row?.avgDurationMs),
      medianDurationMs: roundMs(row?.medianDurationMs),
      notMeasurableCount: doneCount - num(row?.measurableCount),
    };
  }

  async function extremeTasks(companyId: string, range: ResolvedStatsRange, projectId?: string) {
    // fastest/slowest rank issues at any level, unlike every other count here.
    const statement = sql`
      with measurable as (
        select ${issues.id}::text as "issueId",
               ${issues.identifier} as "identifier",
               ${issues.title} as "title",
               ${issues.projectId}::text as "projectId",
               ${issues.completedAt} as "completedAt",
               ${measurableDurationMs()} as "durationMs"
        from ${issues}
        where ${doneInRangeCondition(companyId, range)}
          and ${issues.startedAt} is not null
          and ${issues.completedAt} >= ${issues.startedAt}${projectFilter(projectId)}
      )
      select 'fastest' as kind, "issueId", "identifier", "title", "projectId", "durationMs"
      from (select * from measurable order by "durationMs" asc, "completedAt" asc, "issueId" asc limit 1) as f
      union all
      select 'slowest' as kind, "issueId", "identifier", "title", "projectId", "durationMs"
      from (select * from measurable order by "durationMs" desc, "completedAt" asc, "issueId" asc limit 1) as s
    `;
    const rows = rowsOf<{
      kind: string;
      issueId: string;
      identifier: string | null;
      title: string;
      projectId: string | null;
      durationMs: unknown;
    }>(await db.execute(statement));
    const pick = (kind: string): StatsTaskExtreme | null => {
      const row = rows.find((candidate) => candidate.kind === kind);
      if (!row) return null;
      return {
        issueId: row.issueId,
        identifier: row.identifier,
        title: row.title,
        projectId: row.projectId,
        durationMs: roundMs(row.durationMs),
      };
    };
    return { fastestTask: pick("fastest"), slowestTask: pick("slowest") };
  }

  async function throughput(companyId: string, range: ResolvedStatsRange, projectId?: string) {
    const perDaySql = sql`
      with days as (${dayScaffold(range)}),
      done as (
        select (${issues.completedAt} at time zone 'UTC')::date as day
        from ${issues}
        where ${doneInRangeCondition(companyId, range)}
          and ${issues.parentId} is null${projectFilter(projectId)}
      )
      select to_char(days.day, 'YYYY-MM-DD') as "date", count(done.day)::int as count
      from days left join done on done.day = days.day
      group by days.day
      order by days.day
    `;

    // Work in flight is a "right now" number, so the range never applies to it.
    const wipStatuses = sql.join(WIP_STATUSES.map((status) => sql`${status}`), sql`, `);
    const openSql = sql`
      select count(*) filter (where ${issues.status} in (${wipStatuses}))::int as "wipCount",
             count(*) filter (where ${issues.status} = 'blocked')::int as "blockedCount"
      from ${issues}
      where ${issues.companyId} = ${companyId}
        and ${visibleIssues()}
        and ${issues.parentId} is null${projectFilter(projectId)}
    `;

    const [perDayResult, openResult] = await Promise.all([db.execute(perDaySql), db.execute(openSql)]);
    const donePerDay: StatsThroughputDay[] = rowsOf<{ date: string; count: unknown }>(perDayResult).map((row) => ({
      date: row.date,
      count: num(row.count),
    }));
    const openRow = rowsOf<{ wipCount: unknown; blockedCount: unknown }>(openResult)[0];
    return {
      donePerDay,
      wipCount: num(openRow?.wipCount),
      blockedCount: num(openRow?.blockedCount),
    };
  }

  async function tokenUsageRows(companyId: string, since: Date): Promise<TokenUsageRow[]> {
    const statement = sql`
      select ${costEvents.accountLabel} as "accountLabel",
             ${costEvents.provider} as provider,
             ${costEvents.agentId} as "agentId",
             coalesce(${agents.name}, 'Unknown agent') as "agentName",
             coalesce(sum(${costEvents.inputTokens}), 0)::bigint as "inputTokens",
             coalesce(sum(${costEvents.cachedInputTokens}), 0)::bigint as "cachedInputTokens",
             coalesce(sum(${costEvents.outputTokens}), 0)::bigint as "outputTokens",
             coalesce(sum(${costEvents.costCents}), 0)::bigint as "costCents",
             count(distinct ${costEvents.heartbeatRunId})::int as "runCount"
      from ${costEvents}
      left join ${agents} on ${agents.id} = ${costEvents.agentId}
      where ${costEvents.companyId} = ${companyId}
        and ${costEvents.occurredAt} >= ${since.toISOString()}::timestamptz
      group by ${costEvents.accountLabel}, ${costEvents.provider}, ${costEvents.agentId}, ${agents.name}
    `;
    return rowsOf<Record<string, unknown>>(await db.execute(statement)).map((row) => ({
      accountLabel: typeof row.accountLabel === "string" ? row.accountLabel : null,
      provider: String(row.provider ?? "unknown"),
      agentId: String(row.agentId),
      agentName: String(row.agentName ?? "Unknown agent"),
      inputTokens: Number(row.inputTokens ?? 0),
      cachedInputTokens: Number(row.cachedInputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      costCents: Number(row.costCents ?? 0),
      runCount: Number(row.runCount ?? 0),
    }));
  }

  return {
    resolveRange: resolveStatsRange,

    /**
     * Tokens per cloud login, per agent, over fixed rolling windows. One query per
     * window; the fold is in memory so accounts and agents share one row set.
     */
    tokenUsage: async (companyId: string, now: Date = new Date()): Promise<StatsTokenUsage> => {
      const [activeAccountLabel, windows] = await Promise.all([
        readActiveClaudeAccountLabel(),
        Promise.all(
          TOKEN_USAGE_WINDOWS.map(async ({ window, hours }) => {
            const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
            return foldTokenUsageWindow(window, hours, since, await tokenUsageRows(companyId, since));
          }),
        ),
      ]);
      return { generatedAt: now.toISOString(), activeAccountLabel, windows };
    },

    overview: async (companyId: string, options: StatsOverviewInput = {}): Promise<StatsOverview> => {
      const range = resolveStatsRange(options);
      const [burn, parentTasks, extremes, flow] = await Promise.all([
        timeBurn(companyId, range, options.projectId),
        parentTaskDurations(companyId, range, options.projectId),
        extremeTasks(companyId, range, options.projectId),
        throughput(companyId, range, options.projectId),
      ]);
      return {
        range: { from: range.from.toISOString(), to: range.to.toISOString() },
        timeBurn: burn,
        parentTasks,
        fastestTask: extremes.fastestTask,
        slowestTask: extremes.slowestTask,
        throughput: flow,
      };
    },

    byProject: async (companyId: string, options: StatsRangeInput = {}): Promise<StatsByProject> => {
      const range = resolveStatsRange(options);
      const runIssues = alias(issues, "run_issues");
      const costIssues = alias(issues, "cost_issues");
      // cost_events carries a project on most rows; where it does not, the issue the
      // event was booked against does.
      const spendProjectId = sql`coalesce(${costEvents.projectId}, ${costIssues.projectId})`;

      const statement = sql`
        with done as (
          select ${issues.projectId} as project_id, ${measurableDurationMs()} as ms
          from ${issues}
          where ${doneInRangeCondition(companyId, range)}
            and ${issues.parentId} is null
            and ${issues.projectId} is not null
        ),
        done_agg as (
          select project_id,
                 count(*)::int as done_count,
                 coalesce(avg(ms) filter (where ms is not null), 0)::double precision as avg_ms,
                 coalesce(
                   percentile_cont(0.5) within group (order by ms) filter (where ms is not null),
                   0
                 )::double precision as median_ms
          from done
          group by project_id
        ),
        run_time as (
          select ${runIssues.projectId} as project_id,
                 coalesce(sum(${runDurationMs()}), 0)::double precision as ms
          from ${heartbeatRuns}
          join ${issues} ${runIssues}
            on ${runIssues.companyId} = ${companyId}
           and ${runIssues.id}::text = coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot} ->> 'issueId')
          where ${finishedRunCondition(companyId, range)}
            and ${runIssues.projectId} is not null
          group by ${runIssues.projectId}
        ),
        spend as (
          select ${spendProjectId} as project_id,
                 coalesce(sum(${costEvents.costCents}), 0)::double precision as cents
          from ${costEvents}
          left join ${issues} ${costIssues}
            on ${costIssues.companyId} = ${companyId}
           and ${costIssues.id} = ${costEvents.issueId}
          where ${costEvents.companyId} = ${companyId}
            and ${costEvents.occurredAt} >= ${ts(range.from)}
            and ${costEvents.occurredAt} <= ${ts(range.to)}
            and ${spendProjectId} is not null
          group by ${spendProjectId}
        )
        select ${projects.id}::text as "projectId",
               ${projects.name} as "name",
               coalesce(done_agg.done_count, 0)::int as "doneCount",
               coalesce(done_agg.avg_ms, 0)::double precision as "avgDurationMs",
               coalesce(done_agg.median_ms, 0)::double precision as "medianDurationMs",
               coalesce(run_time.ms, 0)::double precision as "timeSpentMs",
               coalesce(spend.cents, 0)::double precision as "spendCents",
               case
                 when coalesce(done_agg.done_count, 0) > 0
                 then round((coalesce(spend.cents, 0) / done_agg.done_count)::numeric, 2)::double precision
                 else 0
               end as "costPerDoneTaskCents"
        from ${projects}
        left join done_agg on done_agg.project_id = ${projects.id}
        left join run_time on run_time.project_id = ${projects.id}
        left join spend on spend.project_id = ${projects.id}
        where ${projects.companyId} = ${companyId}
          and (done_agg.project_id is not null or run_time.project_id is not null or spend.project_id is not null)
        order by "doneCount" desc, "timeSpentMs" desc, ${projects.name} asc
      `;

      const rows = rowsOf<Record<string, unknown>>(await db.execute(statement));
      const projectRows: StatsProjectPerformance[] = rows.map((row) => ({
        projectId: String(row.projectId),
        name: String(row.name ?? ""),
        doneCount: num(row.doneCount),
        avgDurationMs: roundMs(row.avgDurationMs),
        medianDurationMs: roundMs(row.medianDurationMs),
        timeSpentMs: roundMs(row.timeSpentMs),
        spendCents: num(row.spendCents),
        costPerDoneTaskCents: num(row.costPerDoneTaskCents),
      }));
      return { projects: projectRows };
    },
  };
}
