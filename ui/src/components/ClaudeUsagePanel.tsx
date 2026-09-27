import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { ClaudeSubscriptionPanel } from "./ClaudeSubscriptionPanel";

/**
 * Dashboard: Claude subscription usage (session, weekly, extra usage) of the
 * account the server's agents run on. Same data and cache as the Costs page.
 */
export function ClaudeUsagePanel({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    refetchInterval: 300_000,
    staleTime: 60_000,
  });
  const anthropic = data?.find((result) => result.provider === "anthropic");

  return (
    <div className="min-w-0" data-testid="dashboard-claude-usage">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Claude usage</h3>
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
