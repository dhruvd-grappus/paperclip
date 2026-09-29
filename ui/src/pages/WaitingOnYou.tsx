import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { WAITING_ON_YOU_UNASSIGNED, waitingOnYouApi } from "../api/waiting-on-you";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { WaitingOnYouPanel } from "../components/WaitingOnYouPanel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Filter value for "no filter" — `Select` cannot carry an empty string. */
const ALL_OWNERS = "__all";

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
 * The owner filter is a server filter, not a client-side slice: the response
 * always reports the unfiltered owners, so narrowing the list never empties
 * the picker you narrowed it with.
 */
export function WaitingOnYou() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [owner, setOwner] = useState<string>(ALL_OWNERS);

  useEffect(() => {
    setBreadcrumbs([{ label: "Waiting On You" }]);
  }, [setBreadcrumbs]);

  const ownerFilter = owner === ALL_OWNERS ? null : owner;
  const { data: feed } = useQuery({
    queryKey: queryKeys.waitingOnYou(selectedCompanyId!, ownerFilter),
    queryFn: () => waitingOnYouApi.list(selectedCompanyId!, { user: ownerFilter }),
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

  const owners = feed?.owners ?? [];
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
        <Select value={owner} onValueChange={setOwner}>
          <SelectTrigger className="w-56" data-testid="waiting-on-you-owner-filter">
            <SelectValue placeholder="Anyone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_OWNERS}>Anyone · {total}</SelectItem>
            {owners.map((entry) => (
              <SelectItem
                key={entry.userId ?? WAITING_ON_YOU_UNASSIGNED}
                value={entry.userId ?? WAITING_ON_YOU_UNASSIGNED}
              >
                {(entry.userId ? userName(entry.userId) : null) ??
                  (entry.userId ? "Unknown person" : "No owner")}{" "}
                · {entry.count}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {ownerFilter ? (
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
