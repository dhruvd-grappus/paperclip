import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ReportedProblemByVersion } from "@paperclipai/shared";
import { CircleAlert } from "lucide-react";
import { reportedProblemsApi } from "../api/reportedProblems";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { formatDate } from "../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const NO_COMPANY = "__none__";

const COPY = {
  title: "Reported problems",
  subtitle: "Paperclip problems filed by the board, grouped by the Clarifier's AGENTS.md version.",
  noCompany: "Select an organization to view reported problems.",
  empty: "No problems reported yet.",
  emptyHint: "Use \"Report a Paperclip problem\" on any issue to file one.",
  unversioned: "No AGENTS.md version",
  problem: "problem",
  problems: "problems",
  sourceIssue: "Source issue",
};

function versionLabel(version: number | null): string {
  return version === null ? COPY.unversioned : `V${version}`;
}

export function ReportedProblems() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: COPY.title }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? NO_COMPANY;
  const enabled = !!selectedCompanyId;

  const { data: groups, isLoading, error } = useQuery({
    queryKey: ["reported-problems", "by-version", companyId] as const,
    queryFn: () => reportedProblemsApi.byVersion(companyId),
    enabled,
    staleTime: 30_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleAlert} message={COPY.noCompany} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="costs" />;
  }

  if (error) {
    return <EmptyState icon={CircleAlert} message="Failed to load reported problems." />;
  }

  const rows: ReportedProblemByVersion[] = groups ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{COPY.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{COPY.subtitle}</p>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={CircleAlert} message={COPY.empty} description={COPY.emptyHint} />
      ) : (
        <div className="space-y-4">
          {rows.map((group) => (
            <Card key={group.version ?? "none"}>
              <CardHeader>
                <CardTitle className="text-sm font-medium">{versionLabel(group.version)}</CardTitle>
                <CardDescription>
                  {group.count} {group.count === 1 ? COPY.problem : COPY.problems}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {group.problems.map((problem) => (
                  <div key={problem.id} className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">{problem.title}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(problem.createdAt)}</span>
                    </div>
                    {problem.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">{problem.description}</p>
                    ) : null}
                    {problem.sourceIssueId ? (
                      <Link
                        to={`/issues/${problem.sourceIssueId}`}
                        className="mt-2 inline-block text-xs text-primary hover:underline"
                      >
                        {COPY.sourceIssue}
                      </Link>
                    ) : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
