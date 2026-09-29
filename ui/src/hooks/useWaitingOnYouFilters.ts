import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { projectsApi } from "../api/projects";
import {
  WAITING_ON_YOU_UNASSIGNED,
  WAITING_ON_YOU_UNFILED,
  waitingOnYouApi,
} from "../api/waiting-on-you";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import type { FacetOption } from "../components/FacetMultiSelect";

/**
 * The Waiting On You list together with its two filters, for the dashboard
 * widget and the `/waiting-on-you` page alike (GRA-328).
 *
 * Both surfaces show the same rows, so both need the same pickers; keeping the
 * wiring in one hook is what stops them drifting into two lists that filter by
 * subtly different things. The directory and project queries use the shared
 * query keys, so mounting this twice costs no extra request.
 *
 * The options are built from the feed's *unfiltered* facets, not from the
 * directories: these are the values actually present in the list, with the row
 * count each one holds. A person with nothing waiting is not worth offering,
 * and a picker never loses the option you are still ticking through.
 */
export function useWaitingOnYouFilters(companyId: string | null | undefined, options: {
  /** Initial selections — the dashboard hands these to `/waiting-on-you`. */
  initialOwners?: readonly string[];
  initialProjects?: readonly string[];
} = {}) {
  const [owners, setOwners] = useState<string[]>([...(options.initialOwners ?? [])]);
  const [projects, setProjects] = useState<string[]>([...(options.initialProjects ?? [])]);

  const { data: feed } = useQuery({
    queryKey: queryKeys.waitingOnYou(companyId!, owners, projects),
    queryFn: () => waitingOnYouApi.list(companyId!, { users: owners, projects }),
    enabled: !!companyId,
    refetchInterval: 60_000,
  });

  // Names for the project picker. The feed reports which projects are present
  // and how many rows each holds; the project list is only asked for names.
  const { data: projectList } = useQuery({
    queryKey: queryKeys.projects.list(companyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(companyId!, { includeArchived: true }),
    enabled: !!companyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userName = useMemo(
    () => (userId: string | null | undefined) =>
      userId ? userProfileMap.get(userId)?.label ?? null : null,
    [userProfileMap],
  );

  const ownerOptions = useMemo<FacetOption[]>(
    () =>
      (feed?.owners ?? []).map((entry) => ({
        value: entry.userId ?? WAITING_ON_YOU_UNASSIGNED,
        label: entry.userId ? userName(entry.userId) ?? "Unknown person" : "No owner",
        count: entry.count,
      })),
    [feed?.owners, userName],
  );

  const projectOptions = useMemo<FacetOption[]>(() => {
    const names = new Map((projectList ?? []).map((project) => [project.id, project.name] as const));
    return (feed?.projects ?? []).map((entry) => ({
      value: entry.projectId ?? WAITING_ON_YOU_UNFILED,
      label: entry.projectId ? names.get(entry.projectId) ?? "Unknown project" : "No project",
      count: entry.count,
    }));
  }, [feed?.projects, projectList]);

  // The query string that carries the current selection to `/waiting-on-you`,
  // so the widget's "+N more" opens the list you were looking at rather than
  // dropping the filters on the way.
  const search = useMemo(() => {
    const params = new URLSearchParams();
    for (const owner of owners) params.append("user", owner);
    for (const project of projects) params.append("project", project);
    const query = params.toString();
    return query ? `?${query}` : "";
  }, [owners, projects]);

  return {
    rows: feed?.items ?? [],
    owners,
    setOwners,
    projects,
    setProjects,
    ownerOptions,
    projectOptions,
    userName,
    filtering: owners.length > 0 || projects.length > 0,
    shownCount: feed?.items.length ?? 0,
    totalCount: feed?.totalCount ?? 0,
    search,
  };
}
