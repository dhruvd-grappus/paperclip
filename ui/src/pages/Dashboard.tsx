import { useEffect, useMemo } from "react";
import { useLocation } from "@/lib/router";
import {
  onboardingStepForCompany,
  shouldRouteAgentlessCompanyToOnboarding,
} from "../lib/onboarding-route";
import { claimOnboardingOffer } from "../lib/onboarding-auto-open";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { attentionApi } from "../api/attention";
import { projectsApi } from "../api/projects";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

import { Bot, CircleCheck, CircleDot, OctagonAlert, LayoutDashboard, PauseCircle, BellRing, UserCheck } from "lucide-react";
import { RunningByProjectPanel } from "../components/RunningByProjectPanel";
import { HumanInterventionPanel } from "../components/HumanInterventionPanel";
import { WaitingOnYouPanel } from "../components/WaitingOnYouPanel";
import { ClaudeUsagePanel } from "../components/ClaudeUsagePanel";
import { dashboardTaskMetrics } from "../lib/dashboard-task-metrics";
import { visibleWorkTasks } from "../lib/task-visibility";
import { heartbeatsApi } from "../api/heartbeats";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "../components/InlineBanner";
import type { Agent } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SmokeLabDashboardCard } from "../components/SmokeLabDashboardCard";

export type PausedAgentBanner =
  | { kind: "imported"; pausedImportedAgentIds: string[] }
  | { kind: "all-paused" }
  | null;

/**
 * Which paused-agents banner the dashboard should show. Import-paused agents
 * get the specific banner with a bulk resume (they were parked by the import
 * safety default and stay parked until someone acts); otherwise a company
 * whose agents are ALL paused gets a generic explanation, because from the
 * outside it is indistinguishable from a broken company.
 */
export function derivePausedAgentBanner(agents: Agent[] | undefined): PausedAgentBanner {
  if (!agents || agents.length === 0) return null;
  const importedPaused = agents.filter(
    (agent) => agent.status === "paused" && agent.pauseReason === "import",
  );
  if (importedPaused.length > 0) {
    return { kind: "imported", pausedImportedAgentIds: importedPaused.map((agent) => agent.id) };
  }
  if (agents.every((agent) => agent.status === "paused")) return { kind: "all-paused" };
  return null;
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();

  // `isFetching` is read alongside the data: a cached list is served while its
  // refetch runs, and an empty one from before the first hire must not pass
  // for the company's current state — see `shouldRouteAgentlessCompanyToOnboarding`.
  const { data: agents, isFetching: agentsRefreshing } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Bulk resume for agents parked by a company import. Sequential on purpose
  // (mirrors the import page's activation checklist); a per-agent failure is
  // tolerated so one bad agent never blocks the rest, and the refetch below
  // re-renders the banner with whatever remains paused.
  const queryClient = useQueryClient();
  const resumeImportedAgents = useMutation({
    mutationFn: async () => {
      const targets = derivePausedAgentBanner(agents);
      if (!targets || targets.kind !== "imported") return;
      for (const agentId of targets.pausedImportedAgentIds) {
        try {
          await agentsApi.resume(agentId, selectedCompanyId ?? undefined);
        } catch {
          // Leave the agent paused; the banner re-renders with the remainder.
        }
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) }),
      ]);
    },
  });

  // A company with no agent cannot do anything — no runs, no tasks, nothing
  // to show. The banner below already says so and offers a link; this takes
  // the customer there instead of asking them to notice.
  //
  // It also closes the gap a Cloud-provisioned stack falls into. Cloud creates
  // the company before the tenant boots, so the companyless redirect never
  // fires and a seeded customer lands here, on an empty dashboard, straight
  // out of signup.
  //
  // Opened as the dialog rather than navigated to: the wizard is already
  // mounted globally, so there is no route to race and no redirect to loop.
  // Placed with the other hooks — the early returns below mean anything
  // further down would be called conditionally.
  //
  // The company and the step are both passed. Opening with empty options would
  // start the wizard at the front door with no company, and the new-company
  // path there would create a *second* company instead of giving this one an
  // agent.
  const shouldOpenOnboarding = shouldRouteAgentlessCompanyToOnboarding({
    pathname: location.pathname,
    agentsLoaded: agents !== undefined,
    agentsRefreshing,
    agentCount: agents?.length ?? 0,
  });
  // Auto-open once per company. Every input to the effect sits behind a query,
  // so a refetch re-runs it, and the customer can also navigate away and come
  // back — both would otherwise call `openOnboarding` again and reopen a
  // wizard that was deliberately closed. `claimOnboardingOffer` holds the
  // companies already offered; see it for why that outlives this component.
  useEffect(() => {
    if (!shouldOpenOnboarding || !selectedCompanyId) return;
    if (!claimOnboardingOffer(selectedCompanyId)) return;
    openOnboarding({
      companyId: selectedCompanyId,
      initialStep: onboardingStepForCompany(),
    });
    // No mission lookup to wait on any more: the step this opens is the same
    // whatever the goals say, so waiting only delayed the open.
  }, [shouldOpenOnboarding, selectedCompanyId, openOnboarding]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const dashboardQueryKey = queryKeys.dashboard(selectedCompanyId!);
  const sharedDashboard = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "dashboard",
    queryKey: dashboardQueryKey,
    enabled: !!selectedCompanyId,
  });
  const { data, isLoading, error, dataUpdatedAt: dashboardUpdatedAt } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  usePublishSharedQueryData(sharedDashboard, data, dashboardUpdatedAt);


  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  // Pending questions and confirmations for the "Waiting on you" panel. Same
  // query key and cadence as the sidebar badge and the OS notifier, so the
  // three share one cache entry instead of each polling the feed. Board-only
  // endpoint: a non-board viewer gets no items and the panel falls back to the
  // in-review tasks it derives from the issue list.
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Inline status changes from the two panels below. Both the task list and
  // the attention feed are invalidated: a status change can add or remove a
  // row in either (approving a review takes it off the desk), and the panels
  // read from both.
  const updateIssueStatus = useMutation({
    mutationFn: ({ issueId, data }: { issueId: string; data: { status: string } }) =>
      issuesApi.update(issueId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) });
    },
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  // Same query key as the sidebar, so both share one live-runs cache entry.
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const liveIssueIds = useMemo(
    () => new Set((liveRuns ?? []).flatMap((run) => (run.issueId ? [run.issueId] : []))),
    [liveRuns],
  );
  // The task list endpoint returns hidden, harness and chat-container tasks and
  // leaves the filtering to the caller, while every server-side count applies
  // `executionIssueCondition`. Filter once here so no panel or metric on this
  // page shows a task the rest of the product treats as absent.
  const visibleIssues = useMemo(() => visibleWorkTasks(issues ?? []), [issues]);
  const taskMetrics = useMemo(() => dashboardTaskMetrics(visibleIssues), [visibleIssues]);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperclip. Set up your first organization and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select an organization to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  // Same rule as the auto-offer above: a list still being refreshed may be the
  // empty one cached before the first hire, and the banner's "Create one here"
  // opens the same agent step the offer does.
  const hasNoAgents = agents !== undefined && !agentsRefreshing && agents.length === 0;
  const pausedBanner = derivePausedAgentBanner(agents);
  const pausedImportedCount =
    pausedBanner?.kind === "imported" ? pausedBanner.pausedImportedAgentIds.length : 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {pausedBanner?.kind === "imported" ? (
        <InlineBanner
          tone="warning"
          icon={PauseCircle}
          title={`${pausedImportedCount} imported agent${pausedImportedCount === 1 ? " is" : "s are"} paused and will not run.`}
          actions={
            <Button
              size="sm"
              onClick={() => resumeImportedAgents.mutate()}
              disabled={resumeImportedAgents.isPending}
              data-testid="dashboard-resume-imported-agents"
            >
              {resumeImportedAgents.isPending ? "Resuming…" : "Resume all"}
            </Button>
          }
        >
          Agents from an organization import arrive paused as a safety default. Resume them so assigned tasks can start.
        </InlineBanner>
      ) : pausedBanner?.kind === "all-paused" ? (
        <InlineBanner
          tone="warning"
          icon={PauseCircle}
          title="All agents in this organization are paused — nothing will run."
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link to="/agents">Review agents</Link>
            </Button>
          }
        >
          Resume at least one agent to let assigned tasks start.
        </InlineBanner>
      ) : null}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 3, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-(image:--gradient-extract-1) px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-950 dark:text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-900/70 dark:text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-900 dark:text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          {/*
            * Where each number comes from matters. `data.tasks` and
            * `data.humanApproved` are counted by the server over every task in
            * the company, so they are exact; `taskMetrics` is derived from the
            * task list this page loaded, which the API caps at 500, so it
            * under-reports on a large board. Anything the server can count is
            * therefore read from `data`, and only the two figures that need
            * per-task state the summary does not carry — the 7-day window and
            * the attention predicates — come from `taskMetrics`.
            */}
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-1 sm:gap-2">
            <MetricCard
              icon={CircleCheck}
              value={taskMetrics.doneLast7Days}
              label="Tasks Done"
              // Both finished statuses: the count uses `isCompletedIssueStatus`,
              // so a task a person signed off is delivered work too. The list
              // has no date filter, so it shows all of them, not just 7 days.
              to="/issues?status=done,human_approved"
              description={<span>last 7 days · {data.tasks.done} all time</span>}
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks In Progress"
              to="/issues?status=in_progress"
              description={<span>{data.tasks.open} open · {liveIssueIds.size} with a live agent run</span>}
            />
            <MetricCard
              icon={OctagonAlert}
              value={data.tasks.blocked}
              label="Tasks Blocked"
              to="/issues?status=blocked"
              description={
                <span>
                  {taskMetrics.blockedNeedingAttention > 0
                    ? `${taskMetrics.blockedNeedingAttention} need attention`
                    : "none need attention"}
                </span>
              }
            />
            <MetricCard
              icon={BellRing}
              // Client-side by necessity: "no live path is moving it" reads
              // each task's blocker and review attention, which the summary
              // does not carry. Capped with the loaded list.
              value={taskMetrics.needsAttention}
              label="Needs Attention"
              // No status describes this one — it is open tasks whose blocker or
              // review has stalled — so the list takes it as an attention
              // filter sharing the card's own predicate.
              to="/issues?attention=needs_attention"
              description={
                <span>
                  {taskMetrics.awaitingHuman > 0
                    ? `${taskMetrics.awaitingHuman} waiting on a person`
                    : "no task is waiting on a person"}
                </span>
              }
            />
            <MetricCard
              icon={UserCheck}
              value={data.humanApproved?.tasks ?? 0}
              label="Human Approved"
              // The number counts tasks, so the card opens the task list on
              // that status. `/approvals` is the queue of approvals still
              // pending, which is the neighbouring card's job.
              to="/issues?status=human_approved"
              description={
                <span>
                  tasks a person signed off · {(data.humanApproved?.confirmations ?? 0) + (data.humanApproved?.approvals ?? 0)} decisions
                </span>
              }
            />
          </div>

          <WaitingOnYouPanel
            attentionItems={attentionFeed?.items ?? []}
            // The unfiltered list on purpose: the row builder needs to tell a
            // hidden task from one it has never heard of, so it applies the
            // visibility rule itself.
            issues={issues ?? []}
            userName={(userId) => (userId ? userProfileMap.get(userId)?.label ?? null : null)}
            onUpdateIssue={(issueId, data) => updateIssueStatus.mutate({ issueId, data })}
          />

          <HumanInterventionPanel
            issues={visibleIssues}
            userName={(userId) => (userId ? userProfileMap.get(userId)?.label ?? null : null)}
            onUpdateIssue={(issueId, data) => updateIssueStatus.mutate({ issueId, data })}
          />

          <RunningByProjectPanel issues={visibleIssues} projects={projects ?? []} liveIssueIds={liveIssueIds} />

          <SmokeLabDashboardCard companyId={selectedCompanyId!} />

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            // design-allow(card-pattern): class-string prop consumed by the plugin outlet; a component can't be passed here (C5a Run 3)
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <ClaudeUsagePanel companyId={selectedCompanyId!} />

        </>
      )}
    </div>
  );
}
