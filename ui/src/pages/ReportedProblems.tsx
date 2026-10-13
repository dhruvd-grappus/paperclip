import { useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import type { Agent, Issue, Project } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { reportedProblemsApi } from "../api/reportedProblems";
import { IssuesList } from "../components/IssuesList";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { usePublishSharedQueryData, useSharedPollingQuery } from "@/hooks/useSharedPolling";
import { resolveIssuesPresentation } from "./Issues";

const NO_COMPANY = "__none__";
const REPORTED_PROBLEM_ORIGIN_KIND = "reported_problem";
const PAPERCLIP_FIXER_AGENT_ID = "e3ab0ce8-5bba-40cf-816a-108331f331c4";

function versionLabel(version: number | null): string {
  return version === null ? "No AGENTS.md version" : `AGENTS.md V${version}`;
}

/**
 * `/reported-problems` is the dedicated surface for problems filed via the
 * "Report a Paperclip problem" flow. A reported problem is a Paperclip issue
 * (status `backlog`, `originKind = "reported_problem"`, assignee
 * `@PaperClipFixer`), not a separate entity — see
 * `server/src/services/reported-problems.ts:create`. The page therefore
 * renders the standard `IssuesList` (with its full filter / search / sort /
 * status / column toolbar) scoped to `originKind = "reported_problem"` and
 * pre-filtered to `backlog`, so the fixer can pick a problem up, transition
 * it through the normal backlog → todo → in_progress → done flow, and the
 * rest of the board sees the same row. A small badge annotates each row with
 * the AGENTS.md version that was active when the problem was filed, so the
 * original per-version grouping is still visible.
 */
export function ReportedProblems() {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const issuesPresentation = resolveIssuesPresentation(streamlinedUiEnabled);
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Reported problems" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? NO_COMPANY;
  const enabled = !!selectedCompanyId;

  const { data: agents } = useQuery<Agent[]>({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled,
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled,
  });

  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled,
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  const { data: issues, isLoading, error } = useQuery<Issue[]>({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      REPORTED_PROBLEM_ORIGIN_KIND,
    ],
    queryFn: () => issuesApi.list(selectedCompanyId!, { originKind: REPORTED_PROBLEM_ORIGIN_KIND }),
    enabled,
  });

  // The by-version endpoint is still the cheapest source for the per-version
  // annotation badge on each row. We only need the {id → version} map, so we
  // fold the array once and throw the rest away.
  const { data: byVersionGroups } = useQuery({
    queryKey: ["reported-problems", "by-version", companyId] as const,
    queryFn: () => reportedProblemsApi.byVersion(companyId),
    enabled,
    staleTime: 30_000,
  });

  const versionByReportedProblemId = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const group of byVersionGroups ?? []) {
      for (const problem of group.problems) {
        if (!problem.backlogIssueId) continue;
        map.set(problem.backlogIssueId, group.version);
      }
    }
    return map;
  }, [byVersionGroups]);

  const issueBadgeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues ?? []) {
      if (!versionByReportedProblemId.has(issue.id)) continue;
      map.set(issue.id, versionLabel(versionByReportedProblemId.get(issue.id) ?? null));
    }
    return map;
  }, [issues, versionByReportedProblemId]);

  const liveIssueIds = useMemo(
    () => collectLiveIssueIds(liveRuns, issues ?? []),
    [liveRuns, issues],
  );

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: ["reported-problems", "by-version", companyId] });
    },
  });

  const handleUpdateIssue = useCallback(
    (id: string, data: Record<string, unknown>) => updateIssue.mutate({ id, data }),
    [updateIssue],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleAlert} message="Select an organization to view reported problems." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="costs" />;
  }

  if (error) {
    return <EmptyState icon={CircleAlert} message="Failed to load reported problems." />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Reported problems</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paperclip problems filed by the board. Each row is a backlog task
          assigned to @{PAPERCLIP_FIXER_AGENT_ID.slice(0, 8)}; transition it
          through the normal backlog → todo flow to pick it up.
        </p>
      </div>
      <IssuesList
        issues={issues ?? []}
        agents={agents}
        projects={projects}
        liveIssueIds={liveIssueIds}
        viewStateKey="paperclip:reported-problems-view"
        initialStatuses={["backlog"]}
        rowPresentation={issuesPresentation.rowPresentation}
        toolbarPresentation={issuesPresentation.toolbarPresentation}
        issueBadgeById={issueBadgeById}
        onUpdateIssue={handleUpdateIssue}
      />
    </div>
  );
}