import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { prefetchQueryWithPolicy, queryPolicies, resolveQueryPolicy } from "./queryOptions";
import type { QueryPolicyName } from "./queryOptions";

const names = Object.keys(queryPolicies) as QueryPolicyName[];

describe("queryPolicies", () => {
  it("keeps every entry cacheable long enough to be refetched without a blank paint", () => {
    for (const name of names) {
      const policy = queryPolicies[name];
      if (policy.staleTime === Infinity) continue;
      expect(policy.staleTime, name).toBeGreaterThanOrEqual(0);
      expect(policy.gcTime, name).toBeGreaterThan(policy.staleTime);
    }
  });

  it("does not refetch realtime data on focus — focus is not its change signal", () => {
    expect(queryPolicies.realtime.refetchOnWindowFocus).toBe(false);
    expect(queryPolicies.realtime.staleTime).toBe(0);
  });
});

describe("resolveQueryPolicy", () => {
  it("returns the named policy unchanged without overrides", () => {
    expect(resolveQueryPolicy("warm")).toEqual(queryPolicies.warm);
  });

  it("lets an explicit override win over the policy", () => {
    expect(resolveQueryPolicy("warm", { staleTime: 0 }).staleTime).toBe(0);
  });
});

describe("prefetchQueryWithPolicy", () => {
  it("applies the policy to the prefetched options", async () => {
    const prefetchQuery = vi.fn().mockResolvedValue(undefined);
    const client = { prefetchQuery } as unknown as QueryClient;

    await prefetchQueryWithPolicy(client, "reference", {
      queryKey: ["agents", "c1"],
      queryFn: async () => [],
    });

    expect(prefetchQuery).toHaveBeenCalledWith({
      ...queryPolicies.reference,
      queryKey: ["agents", "c1"],
      queryFn: expect.any(Function),
    });
  });

  it("lets an explicit option override the policy default", async () => {
    const prefetchQuery = vi.fn().mockResolvedValue(undefined);
    const client = { prefetchQuery } as unknown as QueryClient;

    await prefetchQueryWithPolicy(client, "warm", {
      queryKey: ["issues", "c1"],
      queryFn: async () => [],
      staleTime: 5_000,
    });

    expect(prefetchQuery.mock.calls[0][0]).toMatchObject({ staleTime: 5_000 });
  });
});
