import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import {
  instanceProvidersApi,
  type EffortLevel,
  type ProviderVersion,
  type ProvidersAction,
} from "../api/instanceProviders";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const EFFORT_LABEL: Record<EffortLevel, string> = {
  default: "Claude Code default (high)",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function newer(v: ProviderVersion): boolean {
  return Boolean(v.installed && v.latest && v.installed !== v.latest);
}

function VersionRow({ label, version, note }: { label: string; version: ProviderVersion; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span>{label}</span>
      <span className="text-right text-muted-foreground">
        {version.installed ?? "unknown"}
        {newer(version) ? <span className="text-amber-600 dark:text-amber-400"> · {version.latest} on npm</span> : null}
        {note ? <span className="block text-xs">{note}</span> : null}
      </span>
    </div>
  );
}

/**
 * Providers section of the build dialog: the Claude versions this host runs
 * versus npm, the effort level for agent runs, and a host CLI update. Changes
 * are queued for the host's root helper (paperclip-providers), like self-update.
 */
export function SidebarProviders() {
  const queryClient = useQueryClient();
  const [refresh, setRefresh] = useState(false);
  const info = useQuery({
    queryKey: queryKeys.instance.providers,
    queryFn: () => instanceProvidersApi.get(refresh),
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.status?.state;
      return state === "queued" || state === "running" ? 3_000 : false;
    },
  });
  const act = useMutation({
    mutationFn: (body: ProvidersAction) => instanceProvidersApi.act(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.instance.providers }),
  });

  const data = info.data;
  if (!data?.enabled || !data.agentRuntime || !data.hostCli || !data.effort) return null;
  const status = data.status ?? null;
  const busy = act.isPending || status?.state === "queued" || status?.state === "running";

  return (
    <div className="space-y-3 border-t border-border pt-3 text-sm" data-testid="sidebar-providers">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Providers</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setRefresh(true); void info.refetch(); }}
          disabled={info.isFetching}
          aria-label="Check provider versions"
        >
          <RefreshCw className={info.isFetching ? "motion-safe:animate-spin" : undefined} />
        </Button>
      </div>

      <div className="space-y-1">
        <VersionRow
          label="Claude Code (agent runs)"
          version={data.agentRuntime.claudeCode}
          note={`Agent SDK ${data.agentRuntime.sdk.installed ?? "?"} · ACP bridge ${data.agentRuntime.acpBridge.installed ?? "?"} · pinned by the runner`}
        />
        <VersionRow label="Claude Code CLI (host login)" version={data.hostCli} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span>Effort for agent runs</span>
        <Select
          value={data.effort.level}
          disabled={!data.canManage || busy}
          onValueChange={(value) => act.mutate({ action: "set_effort", effortLevel: value as EffortLevel })}
        >
          <SelectTrigger className="h-8 w-auto min-w-40" data-testid="sidebar-providers-effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {data.effort.levels.map((level) => (
              <SelectItem key={level} value={level}>{EFFORT_LABEL[level]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {newer(data.hostCli) && data.canManage ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Claude Code CLI {data.hostCli.latest} is available.</span>
          <Button size="sm" disabled={busy} onClick={() => act.mutate({ action: "update_claude_cli" })}>
            Update CLI
          </Button>
        </div>
      ) : null}

      {busy ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
          {status?.message ?? "Queued for the host."}
        </p>
      ) : status?.state === "failed" ? (
        <p className="text-destructive">{status.message}</p>
      ) : status?.state === "succeeded" && status.message ? (
        <p className="text-xs text-muted-foreground">{status.message}</p>
      ) : null}
      {act.error ? <p className="text-destructive">{(act.error as Error).message}</p> : null}
      {!data.canManage ? <p className="text-xs text-muted-foreground">Only instance admins can change these.</p> : null}
    </div>
  );
}
