import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import {
  instanceBuildApi,
  instanceUpdateApi,
  type InstanceBuildInfo,
  type InstanceUpdateState,
} from "../api/instanceBuild";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

const IN_FLIGHT: ReadonlySet<InstanceUpdateState> = new Set(["queued", "waiting_idle", "installing"]);

const STATE_LABEL: Record<InstanceUpdateState, string> = {
  queued: "Update queued",
  waiting_idle: "Waiting for running agent tasks to finish",
  installing: "Installing and restarting",
  succeeded: "Update installed",
  failed: "Update failed",
  rolled_back: "Update failed and was rolled back",
};

/**
 * "Check for updates" on Settings → Instance settings → Updates. The server
 * only queues a request; the host's updater installs the latest CI build of
 * grappus/stable, restarts
 * Paperclip and reports back. While that runs the API is briefly down, so the
 * panel keeps polling and offers a reload once the running commit changes.
 */
export function SidebarBuildUpdate({ build }: { build: InstanceBuildInfo }) {
  const queryClient = useQueryClient();
  // Commit that ran when this panel queued an update; set = poll until it changes.
  const [startedFrom, setStartedFrom] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  const update = useQuery({
    queryKey: queryKeys.instance.buildUpdate,
    queryFn: () => instanceUpdateApi.get(checked),
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.status?.state;
      return startedFrom || (state && IN_FLIGHT.has(state)) ? 5_000 : false;
    },
  });
  // While an update runs, also watch the running commit (the server restarts).
  const running = useQuery({
    queryKey: [...queryKeys.instance.build, "poll"],
    queryFn: () => instanceBuildApi.get(),
    enabled: Boolean(startedFrom),
    refetchInterval: startedFrom ? 5_000 : false,
    retry: false,
  });

  const start = useMutation({
    mutationFn: (tag: string) => instanceUpdateApi.request(tag),
    onSuccess: () => {
      setStartedFrom(build.commit);
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance.buildUpdate });
    },
  });

  useEffect(() => {
    if (checked) void update.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked]);

  const info = update.data;
  if (!info?.enabled) return null;

  const state = info.status?.state ?? null;
  const inFlight = Boolean(state && IN_FLIGHT.has(state));
  const restartedInto =
    startedFrom && running.data?.commit && running.data.commit !== startedFrom
      ? running.data
      : null;
  const latest = info.latest;

  return (
    <div className="space-y-2 border-t border-border pt-3 text-sm" data-testid="sidebar-build-update">
      {restartedInto ? (
        <div className="flex items-center justify-between gap-3">
          <span>Updated to {restartedInto.shortCommit}{restartedInto.build ? ` · build ${restartedInto.build}` : ""}.</span>
          <Button size="sm" onClick={() => window.location.reload()}>Reload</Button>
        </div>
      ) : inFlight || start.isPending ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
          <span>
            {state ? STATE_LABEL[state] : "Queuing update"}
            {info.status?.message ? ` — ${info.status.message}` : ""}
          </span>
        </div>
      ) : (
        <>
          {state && !IN_FLIGHT.has(state) && info.status?.tag === latest?.tag && state !== "succeeded" ? (
            <p className="text-destructive">{STATE_LABEL[state]}{info.status?.message ? `: ${info.status.message}` : ""}</p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {info.error
                ? `Could not check for updates (${info.error}).`
                : !checked && !info.updateAvailable
                  ? "Check GitHub for a newer build."
                  : info.updateAvailable && latest
                    ? `Build ${latest.build ?? latest.sha} is available (${latest.sha.slice(0, 9)}).`
                    : "You are on the latest build."}
            </span>
            {info.updateAvailable && latest ? (
              info.canUpdate ? (
                <Button size="sm" onClick={() => start.mutate(latest.tag)} data-testid="sidebar-build-update-now">
                  Update now
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Ask an instance admin to update.</span>
              )
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => (checked ? void update.refetch() : setChecked(true))}
                disabled={update.isFetching}
                data-testid="sidebar-build-check"
              >
                <RefreshCw className={update.isFetching ? "motion-safe:animate-spin" : undefined} />
                Check for updates
              </Button>
            )}
          </div>
          {start.error ? <p className="text-destructive">{(start.error as Error).message}</p> : null}
          {info.updateAvailable && info.canUpdate ? (
            <p className="text-xs text-muted-foreground">
              Paperclip restarts once no agent task is running. Pages reconnect by themselves.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
