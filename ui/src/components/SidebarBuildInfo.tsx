import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitCommitHorizontal } from "lucide-react";
import { instanceBuildApi, type InstanceBuildInfo } from "../api/instanceBuild";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function commitUrl(build: InstanceBuildInfo, sha: string): string | null {
  return build.repositoryUrl ? `${build.repositoryUrl}/commit/${sha}` : null;
}

function buildLabel(build: InstanceBuildInfo): string {
  return build.build ? `${build.shortCommit} · build ${build.build}` : build.shortCommit ?? "";
}

/**
 * Sidebar footer: the commit this instance runs. Opens the changelog, the
 * fork's commits since its upstream base, newest first.
 */
export function SidebarBuildInfo({ rail }: { rail: boolean }) {
  const [open, setOpen] = useState(false);
  const { data: build } = useQuery({
    queryKey: queryKeys.instance.build,
    queryFn: () => instanceBuildApi.get(),
    staleTime: Infinity,
  });
  if (!build?.shortCommit) return null;

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={rail ? `Running ${buildLabel(build)}` : undefined}
      data-testid="sidebar-build-info"
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
      <span className={cn("truncate font-mono", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}>{buildLabel(build)}</span>
    </button>
  );

  return (
    <div className="shrink-0 border-t border-border px-2 py-1.5">
      {rail ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">{buildLabel(build)}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Running {buildLabel(build)}</DialogTitle>
            <DialogDescription>
              {build.base
                ? `${build.branch ?? "fork"} on upstream v${build.base}${build.builtAt ? `, built ${formatDateTime(build.builtAt)}` : ""}.`
                : "Upstream Paperclip build."}
            </DialogDescription>
          </DialogHeader>
          {build.commits.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes on top of the upstream release.</p>
          ) : (
            <ol className="max-h-[60vh] space-y-3 overflow-y-auto pr-1" data-testid="sidebar-build-changelog">
              {build.commits.map((commit) => {
                const url = commitUrl(build, commit.sha);
                return (
                  <li key={commit.sha} className="rounded-lg border border-border p-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-foreground">{commit.subject}</span>
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {commit.shortSha}
                        </a>
                      ) : (
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.shortSha}</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {[commit.author, commit.committedAt && formatDateTime(commit.committedAt)].filter(Boolean).join(" · ")}
                      {commit.sha === build.commit ? " · running" : ""}
                    </div>
                    {commit.body ? (
                      <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">{commit.body}</p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
