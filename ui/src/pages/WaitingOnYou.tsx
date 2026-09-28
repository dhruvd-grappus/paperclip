import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";
import { accessApi } from "../api/access";
import { attentionApi } from "../api/attention";
import { issuesApi } from "../api/issues";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { WaitingOnYouPanel } from "../components/WaitingOnYouPanel";

/**
 * `/waiting-on-you` — the whole of the dashboard's Waiting On You list, which
 * the widget links to once it has more rows than it shows.
 *
 * It is not a filtered task list, and it cannot be: half of these rows are
 * pending questions and confirmations that live in the attention feed, not in
 * any task status. So the page reads the same two queries the dashboard does,
 * on the same query keys — one cache entry shared with the widget, the sidebar
 * badge and the notifier — and renders the same component with `showAll`.
 */
export function WaitingOnYou() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Waiting On You" }]);
  }, [setBreadcrumbs]);

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

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
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  // Same inline status editing as the dashboard widget: this page exists so a
  // person can work the list, and working it means changing statuses.
  const updateIssueStatus = useMutation({
    mutationFn: ({ issueId, data }: { issueId: string; data: { status: string } }) =>
      issuesApi.update(issueId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select an organization to see what is waiting on you." />;
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Waiting On You</h1>
        <p className="text-sm text-muted-foreground">
          Every parent task whose next move belongs to a person — questions to answer,
          confirmations to give, tasks in review, and finished work nobody has approved.
          Oldest wait first.
        </p>
      </div>
      <WaitingOnYouPanel
        attentionItems={attentionFeed?.items ?? []}
        issues={issues ?? []}
        userName={(userId) => (userId ? userProfileMap.get(userId)?.label ?? null : null)}
        onUpdateIssue={(issueId, data) => updateIssueStatus.mutate({ issueId, data })}
        showAll
        showHeading={false}
      />
    </div>
  );
}
