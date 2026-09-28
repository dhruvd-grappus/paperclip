import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { ClaudeSubscriptionPanel } from "./ClaudeSubscriptionPanel";

/**
 * Dashboard: Claude subscription usage (session, weekly, extra usage) of the
 * account the server's agents run on, and which account that is right now (the
 * host rotates logins). Same data and cache as the Costs page.
 */
export function ClaudeUsagePanel({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    // the provider's usage endpoint rate limits hard; poll it sparingly
    refetchInterval: 900_000,
    staleTime: 600_000,
    refetchOnWindowFocus: false,
  });
  const anthropic = data?.find((result) => result.provider === "anthropic");
  const account = anthropic?.account ?? null;
  const plan = account?.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : null;

  return (
    <div className="min-w-0" data-testid="dashboard-claude-usage">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="shrink-0 text-sm font-semibold text-muted-foreground uppercase tracking-wide">Claude usage</h3>
          {account?.email ? (
            <span className="truncate text-sm text-foreground" data-testid="dashboard-claude-account" title={account.orgName ?? undefined}>
              {account.email}
              {plan ? <span className="text-muted-foreground"> · {plan}</span> : null}
            </span>
          ) : null}
        </div>
        <Link to="/costs" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Costs
        </Link>
      </div>
      {isLoading ? (
        <div className="border border-border px-4 py-4 text-sm text-muted-foreground">Loading usage…</div>
      ) : (
        <ClaudeSubscriptionPanel
          windows={anthropic?.windows ?? []}
          source={anthropic?.source ?? null}
          error={anthropic ? (anthropic.ok ? null : anthropic.error ?? "Usage unavailable") : "No Claude subscription found on the server"}
        />
      )}
    </div>
  );
}
