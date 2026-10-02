import type { FetchQueryOptions, QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Named cache policies for TanStack Query.
 *
 * The app used to carry a `staleTime` literal on every query — 140 of them at
 * last count, spread across two dozen values — which made "how fresh is this
 * screen" impossible to answer in one place and let two surfaces showing the
 * same resource disagree. Policies name the intent instead:
 *
 * - `immutable` — never changes for the life of the build/session.
 * - `static`    — server metadata that changes on deploy, not on user action.
 * - `reference` — lists a user edits occasionally (agents, projects, members).
 * - `warm`      — the default for page data (dashboard, task list).
 * - `hot`       — counters/badges that should feel live but are cheap to read.
 * - `realtime`  — data a poll or the live-events stream pushes; never refetch
 *                 on focus, because focus is not the change signal.
 *
 * Values are chosen to match the existing per-query behaviour, so migrating a
 * query onto a policy is a no-op until the policy is deliberately retuned.
 * Spreading `...queryPolicies.warm` at the end of a `useQuery` options object
 * lets an explicit override still win.
 */
export type QueryPolicyName =
  | "immutable"
  | "static"
  | "reference"
  | "warm"
  | "hot"
  | "realtime";

export interface QueryPolicy {
  staleTime: number;
  gcTime: number;
  refetchOnWindowFocus: boolean;
  refetchOnReconnect: boolean;
}

export const queryPolicies = {
  immutable: {
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
  static: {
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
  reference: {
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  },
  warm: {
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  },
  hot: {
    staleTime: 5_000,
    gcTime: 2 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  },
  realtime: {
    staleTime: 0,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
} as const satisfies Record<QueryPolicyName, QueryPolicy>;

export function resolveQueryPolicy(
  name: QueryPolicyName,
  overrides?: Partial<QueryPolicy>,
): QueryPolicy {
  return overrides ? { ...queryPolicies[name], ...overrides } : queryPolicies[name];
}

/**
 * Prefetch a query under a named policy. Prefetches must not set their own
 * freshness defaults or a hover-warmed entry would age differently than the
 * mounted query that later reads it.
 */
export function prefetchQueryWithPolicy<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  queryClient: QueryClient,
  name: QueryPolicyName,
  options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
) {
  return queryClient.prefetchQuery({ ...queryPolicies[name], ...options });
}
