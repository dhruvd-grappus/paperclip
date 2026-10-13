// @vitest-environment jsdom

// GRA-632 (paperclip-fixer): `/reported-problems` is the dedicated surface
// for problems filed via the "Report a Paperclip problem" flow. A reported
// problem is a Paperclip issue (`status=backlog`,
// `originKind="reported_problem"`, `assigneeAgentId=PAPERCLIP_FIXER_AGENT_ID`),
// not a separate entity — see `server/src/services/reported-problems.ts:create`.
// The page therefore renders the standard `IssuesList` (full filter / search
// / sort / status toolbar) scoped to `originKind="reported_problem"` and
// pre-filtered to the `backlog` status, so the fixer can transition it
// through the normal backlog → todo flow. Each row also carries the
// AGENTS.md version reported for that problem as a small badge, so the
// per-version grouping stays visible even though the page is the standard
// task list.

import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, ReportedProblemByVersion } from "@paperclipai/shared";
import { ReportedProblems } from "./ReportedProblems";

const issuesListMock = vi.hoisted(() => vi.fn());
const issuesApiListMock = vi.hoisted(() => vi.fn());
const reportedProblemsByVersionMock = vi.hoisted(() => vi.fn());

vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: {
    issues: Issue[];
    initialStatuses?: string[];
    issueBadgeById?: Map<string, string>;
  }) => {
    issuesListMock(props);
    return (
      <div data-testid="reported-issues-list">
        {(props.issues ?? []).map((issue) => (
          <div key={issue.id} data-testid="row" data-id={issue.id}>
            <span data-testid="row-title">{issue.title}</span>
            <span data-testid="row-badge">{props.issueBadgeById?.get(issue.id) ?? ""}</span>
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: (...args: unknown[]) => issuesApiListMock(...args),
    update: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn(async () => []) },
}));

vi.mock("../api/reportedProblems", () => ({
  reportedProblemsApi: {
    byVersion: (...args: unknown[]) => reportedProblemsByVersionMock(...args),
  },
}));

vi.mock("../hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: false, loaded: true }),
}));

vi.mock("@/hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: true, refetchInterval: false, isLeader: true, publish: vi.fn() }),
  usePublishSharedQueryData: () => undefined,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" },
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papReportedPagePatched?: boolean;
  };
  if (!sheetProto.__papReportedPagePatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap-reported-page-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papReportedPagePatched = true;
  }
});

function createReportedProblemIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Reported problem 1",
    description: null,
    status: "backlog",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: "e3ab0ce8-5bba-40cf-816a-108331f331c4",
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 1,
    originKind: "reported_problem",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-10-12T00:00:00.000Z"),
    updatedAt: new Date("2026-10-12T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    blockedBy: [],
    blocks: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: new Date("2026-10-12T00:00:00.000Z"),
    isUnreadForMe: false,
    ...overrides,
  };
}

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/GRA/reported-problems"]}>
          <ReportedProblems />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { container, unmount: () => root.unmount() };
}

describe("ReportedProblems page (GRA-632)", () => {
  let container: HTMLDivElement | undefined;
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    issuesListMock.mockReset();
    issuesApiListMock.mockReset();
    reportedProblemsByVersionMock.mockReset();
  });

  afterEach(() => {
    if (unmount) unmount();
    container?.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the standard IssuesList scoped to reported_problem with backlog default", async () => {
    issuesApiListMock.mockResolvedValueOnce([
      createReportedProblemIssue({ id: "issue-1", title: "Problem one" }),
      createReportedProblemIssue({ id: "issue-2", title: "Problem two" }),
    ]);
    reportedProblemsByVersionMock.mockResolvedValueOnce([]);

    ({ container, unmount } = renderPage());

    await vi.waitFor(() => expect(issuesApiListMock).toHaveBeenCalled());
    expect(issuesApiListMock).toHaveBeenCalledWith("company-1", { originKind: "reported_problem" });

    await vi.waitFor(() => expect(issuesListMock).toHaveBeenCalled());
    const props = issuesListMock.mock.calls.at(-1)?.[0];
    expect(props?.initialStatuses).toEqual(["backlog"]);
    expect(props?.issues.map((issue: Issue) => issue.id)).toEqual(["issue-1", "issue-2"]);
    expect(container?.textContent).toContain("Problem one");
    expect(container?.textContent).toContain("Problem two");
    expect(container?.textContent).toContain("Reported problems");
  });

  it("annotates each row with the AGENTS.md version reported for that problem", async () => {
    const groups: ReportedProblemByVersion[] = [
      {
        version: 2,
        count: 1,
        problems: [
          {
            id: "problem-1",
            companyId: "company-1",
            title: "Problem one",
            description: null,
            sourceIssueId: null,
            commentIds: [],
            backlogIssueId: "issue-1",
            agentInstructionsRevisionId: "rev-2",
            agentInstructionsVersion: 2,
            reportedByAgentId: null,
            reportedByUserId: "user-1",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      {
        version: null,
        count: 1,
        problems: [
          {
            id: "problem-2",
            companyId: "company-1",
            title: "Problem two (unversioned)",
            description: null,
            sourceIssueId: null,
            commentIds: [],
            backlogIssueId: "issue-2",
            agentInstructionsRevisionId: null,
            agentInstructionsVersion: null,
            reportedByAgentId: null,
            reportedByUserId: "user-2",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
    ];

    issuesApiListMock.mockResolvedValueOnce([
      createReportedProblemIssue({ id: "issue-1", title: "Problem one" }),
      createReportedProblemIssue({ id: "issue-2", title: "Problem two (unversioned)" }),
    ]);
    reportedProblemsByVersionMock.mockResolvedValueOnce(groups);

    ({ container, unmount } = renderPage());

    await vi.waitFor(() => expect(issuesListMock).toHaveBeenCalled());
    const props = issuesListMock.mock.calls.at(-1)?.[0];
    const badges: Map<string, string> = props?.issueBadgeById;
    expect(badges).toBeInstanceOf(Map);
    expect(badges.get("issue-1")).toBe("AGENTS.md V2");
    expect(badges.get("issue-2")).toBe("No AGENTS.md version");

    const rows = container?.querySelectorAll('[data-testid="row"]') ?? [];
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute("data-id")).toBe("issue-1");
    expect(rows[0]?.querySelector('[data-testid="row-badge"]')?.textContent).toBe("AGENTS.md V2");
    expect(rows[1]?.querySelector('[data-testid="row-badge"]')?.textContent).toBe(
      "No AGENTS.md version",
    );
  });
});