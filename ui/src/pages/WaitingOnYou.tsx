import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import {
  WAITING_ON_YOU_UNASSIGNED,
  WAITING_ON_YOU_UNFILED,
  waitingOnYouApi,
} from "../api/waiting-on-you";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { WaitingOnYouPanel } from "../components/WaitingOnYouPanel";
import { FacetMultiSelect } from "../components/FacetMultiSelect";

/**
 * `/waiting-on-you` — the whole of the dashboard's Waiting On You list, which
 * the widget links to once it has more rows than it shows.
 *
 * It is not a filtered task list, and it cannot be: half of these rows are
 * pending questions and confirmations that live in the attention feed, not in
 * any task status. So the rows come from the server's own endpoint, which
 * unions both sources and applies the rule (GRA-328) — the same endpoint and
 * the same query key the dashboard widget reads, so the page can never
 * disagree with the card that sent you there.
 *
 * The owner and project filters are server filters, not client-side slices.
 * Both are multi-select and the two axes are ANDed. The response always
 * reports the *unfiltered* owners and projects, so narrowing the list never
 * empties the picker you narrowed it with — which matters far more for a
 * tick-list than for a one-of picker, since the whole point is to tick again.
 */
export function WaitingOnYou() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [owners, setOwners] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Waiting On You" }]);
  }, [setBreadcrumbs]);

  const { data: feed } = useQuery({
    queryKey: queryKeys.waitingOnYou(selectedCompanyId!, owners, projects),
    queryFn: () => waitingOnYouApi.list(selectedCompanyId!, { users: owners, projects }),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  // Names for the project picker. The feed reports which projects are present
  // and how many rows each holds; the project list is only asked for the names.
  const { data: projectList } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userName = (userId: string | null | undefined) =>
    userId ? userProfileMap.get(userId)?.label ?? null : null;

  // Same inline status editing as the dashboard widget: this page exists so a
  // person can work the list, and working it means changing statuses.
  const updateIssueStatus = useMutation({
    mutationFn: ({ issueId, data }: { issueId: string; data: { status: string } }) =>
      issuesApi.update(issueId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["waiting-on-you", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select an organization to see what is waiting on you." />;
  }

  const projectNames = new Map(
    (projectList ?? []).map((project) => [project.id, project.name] as const),
  );
  // Options come from the feed's facets, not from the directories: these are
  // the values actually present in the list, with the count of rows each one
  // holds. A person and a project with nothing waiting are not worth offering.
  const ownerOptions = (feed?.owners ?? []).map((entry) => ({
    value: entry.userId ?? WAITING_ON_YOU_UNASSIGNED,
    label: entry.userId
      ? userName(entry.userId) ?? "Unknown person"
      : "No owner",
    count: entry.count,
  }));
  const projectOptions = (feed?.projects ?? []).map((entry) => ({
    value: entry.projectId ?? WAITING_ON_YOU_UNFILED,
    label: entry.projectId
      ? projectNames.get(entry.projectId) ?? "Unknown project"
      : "No project",
    count: entry.count,
  }));
  const filtering = owners.length > 0 || projects.length > 0;
  const shown = feed?.items.length ?? 0;
  const total = feed?.totalCount ?? 0;

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Waiting On You</h1>
          <p className="text-sm text-muted-foreground">
            Every parent task whose next move belongs to a person — questions to answer,
            confirmations to give, tasks in review, and finished work nobody has approved.
            Scheduled routine runs are left out. Oldest wait first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FacetMultiSelect
            label="people"
            allLabel={`Anyone · ${total}`}
            options={ownerOptions}
            selected={owners}
            onChange={setOwners}
            testId="waiting-on-you-owner-filter"
          />
          <FacetMultiSelect
            label="projects"
            allLabel="All projects"
            options={projectOptions}
            selected={projects}
            onChange={setProjects}
            testId="waiting-on-you-project-filter"
          />
        </div>
      </div>
      {filtering ? (
        <p className="text-xs text-muted-foreground">
          Showing {shown} of {total}.
        </p>
      ) : null}
      <WaitingOnYouPanel
        rows={feed?.items ?? []}
        userName={userName}
        onUpdateIssue={(issueId, data) => updateIssueStatus.mutate({ issueId, data })}
        showAll
        showHeading={false}
      />
    </div>
  );
}
