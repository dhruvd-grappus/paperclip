import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";
import { prefetchQueryWithPolicy } from "./queryOptions";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";

/**
 * Warm everything the Dashboard mounts in parallel.
 *
 * Only the summary query gates the page skeleton; the rest fill panels as they
 * arrive. Prefetching the full set from the sidebar row's hover/focus intent
 * means the skeleton is usually the only thing a first navigation to
 * `/dashboard` ever shows.
 *
 * Every query key here must match the one `Dashboard` mounts, or the prefetch
 * lands under a key nobody reads and costs a wasted request.
 */
export function prefetchDashboard(
  queryClient: QueryClient,
  companyId: string | null | undefined,
): Promise<unknown> {
  if (!companyId) return Promise.resolve();

  return Promise.all([
    prefetchQueryWithPolicy(queryClient, "warm", {
      queryKey: queryKeys.dashboard(companyId),
      queryFn: () => dashboardApi.summary(companyId),
    }),
    prefetchQueryWithPolicy(queryClient, "reference", {
      queryKey: queryKeys.agents.list(companyId),
      queryFn: () => agentsApi.list(companyId),
    }),
    prefetchQueryWithPolicy(queryClient, "warm", {
      queryKey: queryKeys.issues.list(companyId),
      queryFn: () => issuesApi.list(companyId),
    }),
    prefetchQueryWithPolicy(queryClient, "reference", {
      queryKey: queryKeys.projects.list(companyId, { includeArchived: true }),
      queryFn: () => projectsApi.list(companyId, { includeArchived: true }),
    }),
    prefetchQueryWithPolicy(queryClient, "reference", {
      queryKey: queryKeys.access.companyUserDirectory(companyId),
      queryFn: () => accessApi.listUserDirectory(companyId),
    }),
    prefetchQueryWithPolicy(queryClient, "realtime", {
      queryKey: queryKeys.liveRuns(companyId),
      queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    }),
  ]);
}
