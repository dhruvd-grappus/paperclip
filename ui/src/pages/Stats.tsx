import { Fragment, useEffect, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  StatsTaskExtreme,
  StatsTimeBurnDay,
  StatsThroughputDay,
  StatsTokenAgentUsage,
  StatsTokenTotals,
  StatsTokenUsage,
  StatsTokenWindowKey,
} from "@paperclipai/shared";
import { Activity, BarChart3, CircleDashed, Cloud, Gauge, Hourglass, Rabbit, Timer, Turtle } from "lucide-react";
import { statsApi } from "../api/stats";
import { ChartCard } from "../components/ActivityCharts";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useDateRange, PRESET_KEYS, PRESET_LABELS } from "../hooks/useDateRange";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, formatDurationMs, formatTokens } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const NO_COMPANY = "__none__";

/**
 * Page copy lives in one block so it can be lifted into `ui/src/i18n` when the
 * app moves page strings there. Every other page still writes English inline,
 * and `locale-validation.test.ts` requires each of the ~40 locale files to carry
 * every English key, so adding a `stats` namespace today would fail that gate.
 */
const COPY = {
  title: "Stats",
  subtitle: "How much agent time the company spends, and how quickly work gets done.",
  noCompany: "Select an organization to view stats.",
  customPrompt: "Select a start and end date to load data.",
  empty: "No delivery data in this range.",
  emptyHint: "Pick a wider date range, or come back once agents have finished some runs.",
  burn: {
    label: "Agent time per day",
    chartTitle: "Agent time spent per day",
    chartSubtitle: "Total agent run time, by the day each run finished",
    footnote: "Runs that never finished are not counted.",
    noPrevious: "No comparable time in the previous period",
  },
  parentTasks: {
    label: "Average per task",
    note: "Measured from the moment a task starts to the moment it is done, so it excludes time spent waiting in the backlog.",
    notMeasurable: (n: number) => `${n} completed ${n === 1 ? "task has" : "tasks have"} no usable clock and sit outside these averages.`,
  },
  throughput: {
    doneChartTitle: "Tasks done per day",
    doneChartSubtitle: "Parent tasks that reached done, by day",
    wipLabel: "In progress",
    wipSubtitle: "Tasks in progress or in review right now",
    blockedLabel: "Blocked",
    blockedSubtitle: "Tasks waiting on something right now",
  },
  fastest: { title: "Fastest task", description: "Shortest start-to-done time in the range, at any level." },
  slowest: { title: "Slowest task", description: "Longest start-to-done time in the range, at any level." },
  noExtreme: "No task in this range has a measurable start-to-done time.",
  tokens: {
    title: "Token usage by cloud account",
    description:
      "Tokens each agent used, split by the Claude login that served the run. Windows are rolling and end now, independent of the date range above.",
    active: (label: string) => `Runs currently land on ${label}.`,
    activeUnknown: "The active login could not be read.",
    empty: "No token usage recorded in this window.",
    untracked: "Untracked account",
    untrackedHint: "Recorded before account tracking, or by a provider without a login.",
    agentsHeading: "All agents",
    accountsHeading: "Accounts",
    windowLabels: { "1d": "1 day", "5d": "5 days", "7d": "7 days", "30d": "30 days" } as Record<StatsTokenWindowKey, string>,
    columns: {
      name: "Name",
      input: "Input",
      cached: "Cached",
      output: "Output",
      total: "Total",
      share: "Share",
      runs: "Runs",
      spend: "Spend",
    },
    totalRow: "Total",
  },
  projects: {
    title: "Project performance",
    description: "Completed work, delivery speed and spend, by project.",
    empty: "No project completed a task in this range.",
    columns: {
      project: "Project",
      done: "Tasks done",
      median: "Median",
      mean: "Mean",
      timeSpent: "Agent time",
      spend: "Spend",
      costPerTask: "Cost / task",
    },
  },
} as const;

function formatDayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** Percentage change against the previous equal-length range, as display copy. */
function changeCopy(current: number, previous: number): string {
  if (previous <= 0) return COPY.burn.noPrevious;
  const delta = Math.round(((current - previous) / previous) * 100);
  if (delta === 0) return "Unchanged against the previous period";
  const direction = delta > 0 ? "more" : "less";
  return `${Math.abs(delta)}% ${direction} than the previous period`;
}

function MetricTile({
  label,
  value,
  subtitle,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="block p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </Card>
  );
}

/**
 * One bar per calendar day, in the hand-rolled chart grammar the dashboard
 * already uses (`ActivityCharts`); the repo ships no chart library.
 */
function DayBarChart({
  days,
  color,
  emptyMessage,
  tooltip,
}: {
  days: { date: string; value: number }[];
  color: string;
  emptyMessage: string;
  tooltip: (day: { date: string; value: number }) => string;
}) {
  const maxValue = Math.max(...days.map((day) => day.value), 1);
  const hasData = days.some((day) => day.value > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">{emptyMessage}</p>;

  const lastIndex = days.length - 1;
  const midIndex = Math.floor(lastIndex / 2);
  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map((day) => (
          <div key={day.date} className="flex-1 h-full flex flex-col justify-end" title={tooltip(day)}>
            {day.value > 0 ? (
              <div style={{ height: `${(day.value / maxValue) * 100}%`, minHeight: 2, backgroundColor: color }} />
            ) : (
              <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-(--sz-3px) mt-1.5">
        {days.map((day, i) => (
          <div key={day.date} className="flex-1 text-center">
            {i === 0 || i === midIndex || i === lastIndex ? (
              <span className="text-(length:--text-nano) text-muted-foreground tabular-nums">{formatDayLabel(day.date)}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ExtremeTaskCard({
  title,
  description,
  task,
  icon: Icon,
}: {
  title: string;
  description: string;
  task: StatsTaskExtreme | null;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {task ? (
          <>
            <div className="text-2xl font-semibold tabular-nums">{formatDurationMs(task.durationMs)}</div>
            <Link
              to={`/issues/${task.identifier ?? task.issueId}`}
              className="mt-1 block truncate text-sm font-medium text-primary hover:underline"
            >
              {task.identifier ? `${task.identifier} · ` : ""}{task.title}
            </Link>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{COPY.noExtreme}</p>
        )}
      </CardContent>
    </Card>
  );
}

function TokenTotalsCells({ row, denominator }: { row: StatsTokenTotals; denominator: number }) {
  const share = denominator > 0 ? Math.round((row.totalTokens / denominator) * 100) : 0;
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums">{formatTokens(row.inputTokens)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatTokens(row.cachedInputTokens)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatTokens(row.outputTokens)}</td>
      <td className="px-3 py-2 text-right font-medium tabular-nums">{formatTokens(row.totalTokens)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{share}%</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.runCount}</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.costCents > 0 ? formatCents(row.costCents) : "—"}</td>
    </>
  );
}

function TokenTableHead({ nameLabel }: { nameLabel: string }) {
  const c = COPY.tokens.columns;
  return (
    <thead>
      <tr className="border-b border-border text-muted-foreground">
        <th className="px-3 py-2 font-medium">{nameLabel}</th>
        <th className="px-3 py-2 text-right font-medium">{c.input}</th>
        <th className="px-3 py-2 text-right font-medium">{c.cached}</th>
        <th className="px-3 py-2 text-right font-medium">{c.output}</th>
        <th className="px-3 py-2 text-right font-medium">{c.total}</th>
        <th className="px-3 py-2 text-right font-medium">{c.share}</th>
        <th className="px-3 py-2 text-right font-medium">{c.runs}</th>
        <th className="px-3 py-2 text-right font-medium">{c.spend}</th>
      </tr>
    </thead>
  );
}

function AgentRows({ agents, denominator, indent }: { agents: StatsTokenAgentUsage[]; denominator: number; indent?: boolean }) {
  return (
    <>
      {agents.map((agent) => (
        <tr key={agent.agentId} className="border-b border-border/60 last:border-b-0">
          <td className={`px-3 py-2 ${indent ? "pl-7 text-muted-foreground" : "font-medium"}`}>
            <Link to={`/agents/${agent.agentId}`} className="hover:underline">{agent.agentName}</Link>
          </td>
          <TokenTotalsCells row={agent} denominator={denominator} />
        </tr>
      ))}
    </>
  );
}

/**
 * Tokens per cloud login per agent over rolling windows. claude-swap rotates the
 * host login between several Claude accounts, so each account gets its own block
 * with the agents that ran on it, plus an all-accounts agent table.
 */
export function TokenUsageByAccount({ usage }: { usage: StatsTokenUsage }) {
  const [windowKey, setWindowKey] = useState<StatsTokenWindowKey>("7d");
  const window = usage.windows.find((entry) => entry.window === windowKey) ?? usage.windows[0];
  const denominator = window?.totals.totalTokens ?? 0;
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cloud className="h-4 w-4 text-muted-foreground" />
              {COPY.tokens.title}
            </CardTitle>
            <CardDescription>{COPY.tokens.description}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Token usage window">
            {usage.windows.map((entry) => (
              <Button
                key={entry.window}
                variant={entry.window === window?.window ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setWindowKey(entry.window)}
                aria-pressed={entry.window === window?.window}
              >
                {COPY.tokens.windowLabels[entry.window]}
              </Button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {usage.activeAccountLabel ? COPY.tokens.active(usage.activeAccountLabel) : COPY.tokens.activeUnknown}
        </p>
      </CardHeader>
      <CardContent className="space-y-5 px-5 pb-5 pt-2">
        {!window || window.totals.totalTokens === 0 && window.totals.runCount === 0 ? (
          <p className="text-sm text-muted-foreground">{COPY.tokens.empty}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {window.accounts.map((account) => {
                const label = account.accountLabel ?? COPY.tokens.untracked;
                const isActive = !!account.accountLabel && account.accountLabel === usage.activeAccountLabel;
                const share = denominator > 0 ? Math.round((account.totalTokens / denominator) * 100) : 0;
                return (
                  <Card key={`${account.provider}:${account.accountLabel ?? ""}`} className="block p-4">
                    <div className="truncate text-xs font-medium" title={account.accountLabel ?? COPY.tokens.untrackedHint}>
                      {label}{isActive ? " · active" : ""}
                    </div>
                    <div className="mt-2 text-2xl font-semibold tabular-nums">{formatTokens(account.totalTokens)}</div>
                    <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                      {share}% · {account.runCount} run{account.runCount === 1 ? "" : "s"} · {account.agents.length} agent{account.agents.length === 1 ? "" : "s"}
                    </div>
                  </Card>
                );
              })}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-(--sz-44rem) text-left text-sm" aria-label={COPY.tokens.accountsHeading}>
                <TokenTableHead nameLabel={COPY.tokens.accountsHeading} />
                <tbody>
                  {window.accounts.map((account) => (
                    <Fragment key={`${account.provider}:${account.accountLabel ?? ""}`}>
                      <tr className="border-b border-border bg-muted/30">
                        <td className="px-3 py-2 font-medium" title={account.accountLabel ? undefined : COPY.tokens.untrackedHint}>
                          {account.accountLabel ?? COPY.tokens.untracked}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">{account.provider}</span>
                        </td>
                        <TokenTotalsCells row={account} denominator={denominator} />
                      </tr>
                      <AgentRows agents={account.agents} denominator={denominator} indent />
                    </Fragment>
                  ))}
                  <tr className="border-t border-border font-medium">
                    <td className="px-3 py-2">{COPY.tokens.totalRow}</td>
                    <TokenTotalsCells row={window.totals} denominator={denominator} />
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-(--sz-44rem) text-left text-sm" aria-label={COPY.tokens.agentsHeading}>
                <TokenTableHead nameLabel={COPY.tokens.agentsHeading} />
                <tbody>
                  <AgentRows agents={window.agents} denominator={denominator} />
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function Stats() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
  } = useDateRange("30d");

  useEffect(() => {
    setBreadcrumbs([{ label: COPY.title }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? NO_COMPANY;
  const enabled = !!selectedCompanyId && customReady;

  const {
    data: overview,
    isLoading: overviewLoading,
    error: overviewError,
  } = useQuery({
    queryKey: queryKeys.stats.overview(companyId, from || undefined, to || undefined),
    queryFn: () => statsApi.overview(companyId, from || undefined, to || undefined),
    enabled,
    staleTime: 30_000,
  });

  const {
    data: byProject,
    isLoading: byProjectLoading,
    error: byProjectError,
  } = useQuery({
    queryKey: queryKeys.stats.byProject(companyId, from || undefined, to || undefined),
    queryFn: () => statsApi.byProject(companyId, from || undefined, to || undefined),
    enabled,
    staleTime: 30_000,
  });

  const { data: tokenUsage } = useQuery({
    queryKey: queryKeys.stats.tokenUsage(companyId),
    queryFn: () => statsApi.tokenUsage(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BarChart3} message={COPY.noCompany} />;
  }

  const showCustomPrompt = preset === "custom" && !customReady;
  const loading = (overviewLoading || byProjectLoading) && enabled;
  const error = overviewError ?? byProjectError;

  const burnDays: StatsTimeBurnDay[] = overview?.timeBurn.days ?? [];
  const doneDays: StatsThroughputDay[] = overview?.throughput.donePerDay ?? [];
  const projects = byProject?.projects ?? [];
  const parentTasks = overview?.parentTasks;
  const isEmpty =
    !!overview &&
    overview.timeBurn.totalMs === 0 &&
    (parentTasks?.doneCount ?? 0) === 0 &&
    overview.throughput.wipCount === 0 &&
    overview.throughput.blockedCount === 0 &&
    projects.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{COPY.title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{COPY.subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {PRESET_KEYS.map((key) => (
            <Button
              key={key}
              variant={preset === key ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPreset(key)}
              aria-pressed={preset === key}
            >
              {PRESET_LABELS[key]}
            </Button>
          ))}
        </div>
      </div>

      {preset === "custom" ? (
        <div className="flex flex-wrap items-center gap-2 border border-border p-3">
          <input
            type="date"
            aria-label="Start date"
            value={customFrom}
            onChange={(event) => setCustomFrom(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <input
            type="date"
            aria-label="End date"
            value={customTo}
            onChange={(event) => setCustomTo(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          />
        </div>
      ) : null}

      {showCustomPrompt ? (
        <p className="text-sm text-muted-foreground">{COPY.customPrompt}</p>
      ) : loading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      ) : isEmpty ? (
        <>
          <EmptyState icon={BarChart3} message={COPY.empty} description={COPY.emptyHint} />
          {tokenUsage ? <TokenUsageByAccount usage={tokenUsage} /> : null}
        </>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-4">
            <MetricTile
              label={COPY.burn.label}
              value={formatDurationMs(overview?.timeBurn.avgMsPerDay ?? 0)}
              subtitle={changeCopy(overview?.timeBurn.avgMsPerDay ?? 0, overview?.timeBurn.previousAvgMsPerDay ?? 0)}
              icon={Gauge}
            />
            <MetricTile
              label={COPY.parentTasks.label}
              value={formatDurationMs(parentTasks?.avgDurationMs ?? 0)}
              subtitle={`${formatDurationMs(parentTasks?.medianDurationMs ?? 0)} median · ${parentTasks?.doneCount ?? 0} done`}
              icon={Timer}
            />
            <MetricTile
              label={COPY.throughput.wipLabel}
              value={String(overview?.throughput.wipCount ?? 0)}
              subtitle={COPY.throughput.wipSubtitle}
              icon={Activity}
            />
            <MetricTile
              label={COPY.throughput.blockedLabel}
              value={String(overview?.throughput.blockedCount ?? 0)}
              subtitle={COPY.throughput.blockedSubtitle}
              icon={CircleDashed}
            />
          </div>

          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Hourglass className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {COPY.parentTasks.note}
              {parentTasks && parentTasks.notMeasurableCount > 0
                ? ` ${COPY.parentTasks.notMeasurable(parentTasks.notMeasurableCount)}`
                : ""}
            </span>
          </p>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title={COPY.burn.chartTitle} subtitle={COPY.burn.chartSubtitle}>
              <DayBarChart
                days={burnDays.map((day) => ({ date: day.date, value: day.ms }))}
                color="var(--primary)"
                emptyMessage={COPY.empty}
                tooltip={(day) => {
                  const source = burnDays.find((entry) => entry.date === day.date);
                  const runCount = source?.runCount ?? 0;
                  return `${day.date}: ${formatDurationMs(day.value)} across ${runCount} run${runCount === 1 ? "" : "s"}`;
                }}
              />
              <p className="text-(length:--text-nano) text-muted-foreground/60">{COPY.burn.footnote}</p>
            </ChartCard>

            <ChartCard title={COPY.throughput.doneChartTitle} subtitle={COPY.throughput.doneChartSubtitle}>
              <DayBarChart
                days={doneDays.map((day) => ({ date: day.date, value: day.count }))}
                color="var(--status-task-icon-done)"
                emptyMessage={COPY.empty}
                tooltip={(day) => `${day.date}: ${day.value} task${day.value === 1 ? "" : "s"} done`}
              />
            </ChartCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ExtremeTaskCard
              title={COPY.fastest.title}
              description={COPY.fastest.description}
              task={overview?.fastestTask ?? null}
              icon={Rabbit}
            />
            <ExtremeTaskCard
              title={COPY.slowest.title}
              description={COPY.slowest.description}
              task={overview?.slowestTask ?? null}
              icon={Turtle}
            />
          </div>

          <Card>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base">{COPY.projects.title}</CardTitle>
              <CardDescription>{COPY.projects.description}</CardDescription>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-2">
              <div className="overflow-x-auto">
                <table className="w-full min-w-(--sz-44rem) text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="px-3 py-2 font-medium">{COPY.projects.columns.project}</th>
                      <th className="px-3 py-2 text-right font-medium">{COPY.projects.columns.done}</th>
                      <th className="px-3 py-2 text-right font-medium">{COPY.projects.columns.median}</th>
                      <th className="px-3 py-2 text-right font-medium">{COPY.projects.columns.mean}</th>
                      <th className="px-3 py-2 text-right font-medium">{COPY.projects.columns.timeSpent}</th>
                      <th className="px-3 py-2 text-right font-medium">{COPY.projects.columns.spend}</th>
                      <th className="px-3 py-2 text-right font-medium">{COPY.projects.columns.costPerTask}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-8 text-muted-foreground">
                          {COPY.projects.empty}
                        </td>
                      </tr>
                    ) : projects.map((project) => (
                      <tr key={project.projectId} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-3 font-medium">{project.name}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{project.doneCount}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatDurationMs(project.medianDurationMs)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatDurationMs(project.avgDurationMs)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatDurationMs(project.timeSpentMs)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatCents(project.spendCents)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {project.doneCount > 0 ? formatCents(project.costPerDoneTaskCents) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {tokenUsage ? <TokenUsageByAccount usage={tokenUsage} /> : null}
        </>
      )}
    </div>
  );
}
