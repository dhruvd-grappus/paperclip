import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { instanceBuildApi } from "@/api/instanceBuild";
import { SidebarBuildUpdate } from "@/components/SidebarBuildUpdate";
import { SidebarProviders } from "@/components/SidebarProviders";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { Card } from "@/components/ui/card";

/**
 * Instance settings → Updates: the build this instance runs, the self-update
 * check, and the provider (Claude Code) versions and effort level. These used
 * to live inside the sidebar build dialog, which only shows the changelog now.
 */
export function InstanceUpdates() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Updates" },
    ]);
  }, [setBreadcrumbs]);

  const { data: build } = useQuery({
    queryKey: queryKeys.instance.build,
    queryFn: () => instanceBuildApi.get(),
    staleTime: Infinity,
  });

  return (
    <div className="max-w-3xl space-y-6" data-testid="instance-updates-page">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Updates</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Update Paperclip itself and the Claude providers agent runs use.
        </p>
      </div>

      <Card className="block space-y-3 p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Paperclip build</h2>
          <p className="text-sm text-muted-foreground">
            {build?.shortCommit
              ? build.base
                ? `Running ${build.shortCommit}${build.build ? ` · build ${build.build}` : ""} — ${build.branch ?? "fork"} on upstream v${build.base}${build.builtAt ? `, built ${formatDateTime(build.builtAt)}` : ""}.`
                : `Running ${build.shortCommit}${build.build ? ` · build ${build.build}` : ""}.`
              : "Build information is not available."}
          </p>
        </div>
        {build ? <SidebarBuildUpdate build={build} /> : null}
        {/* Renders nothing when the host has no provider helper configured. */}
        <SidebarProviders />
      </Card>
    </div>
  );
}

export default InstanceUpdates;
