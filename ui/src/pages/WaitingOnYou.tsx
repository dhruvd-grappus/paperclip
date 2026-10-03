import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";
import { useSearchParams } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { useWaitingOnYouFilters } from "../hooks/useWaitingOnYouFilters";
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
 * The owner and project filters are server filters, not client-side slices,
 * and the dashboard widget has the same pair from the same hook. Both are
 * multi-select and the two axes are ANDed. The response always reports the
 * *unfiltered* owners and projects, so narrowing the list never empties the
 * picker you narrowed it with — which matters far more for a tick-list than
 * for a one-of picker, since the whole point is to tick again.
 *
 * The selection is read from the query string on arrival, because the widget's
 * "+N more" puts it there: following that link should open the list you were
 * looking at, not the unfiltered one.
 */
export function WaitingOnYou() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const {
    rows,
    owners,
    setOwners,
    projects,
    setProjects,
    ownerOptions,
    projectOptions,
    projectName,
    userName,
    filtering,
    shownCount,
    totalCount,
  } = useWaitingOnYouFilters(selectedCompanyId, {
    // Read once, as the initial selection: the pickers own it from then on, so
    // ticking is not fighting a URL that would have to be rewritten each time.
    initialOwners: searchParams.getAll("user"),
    initialProjects: searchParams.getAll("project"),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Waiting On You" }]);
  }, [setBreadcrumbs]);

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
            allLabel={`Anyone · ${totalCount}`}
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
          Showing {shownCount} of {totalCount}.
        </p>
      ) : null}
      <WaitingOnYouPanel
        rows={rows}
        userName={userName}
        projectName={projectName}
        filtering={filtering}
        onUpdateIssue={(issueId, data) => updateIssueStatus.mutate({ issueId, data })}
        showAll
        showHeading={false}
      />
    </div>
  );
}
