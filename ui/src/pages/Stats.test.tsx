// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StatsByProject, StatsOverview, StatsTokenUsage } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Stats } from "./Stats";

const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const statsApiMocks = vi.hoisted(() => ({
  overview: vi.fn(),
  byProject: vi.fn(),
  tokenUsage: vi.fn(),
}));

vi.mock("../api/stats", () => ({ statsApi: statsApiMocks }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;

function overviewFixture(overrides: Partial<StatsOverview> = {}): StatsOverview {
  return {
    range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z" },
    timeBurn: {
      totalMs: 9 * HOUR,
      avgMsPerDay: 3 * HOUR,
      previousAvgMsPerDay: 2 * HOUR,
      days: [
        { date: "2026-09-26", ms: 2 * HOUR, runCount: 4 },
        { date: "2026-09-27", ms: 3 * HOUR, runCount: 6 },
        { date: "2026-09-28", ms: 4 * HOUR, runCount: 8 },
      ],
    },
    parentTasks: {
      doneCount: 7,
      avgDurationMs: 5 * HOUR,
      medianDurationMs: 4 * HOUR,
      notMeasurableCount: 2,
    },
    fastestTask: {
      issueId: "issue-fast",
      identifier: "GRA-10",
      title: "Fix the login copy",
      projectId: "project-1",
      durationMs: 12 * 60_000,
    },
    slowestTask: {
      issueId: "issue-slow",
      identifier: "GRA-11",
      title: "Rebuild the billing export",
      projectId: "project-1",
      durationMs: 30 * HOUR,
    },
    throughput: {
      donePerDay: [
        { date: "2026-09-26", count: 1 },
        { date: "2026-09-27", count: 3 },
        { date: "2026-09-28", count: 3 },
      ],
      wipCount: 5,
      blockedCount: 2,
    },
    ...overrides,
  };
}

const emptyOverview: StatsOverview = overviewFixture({
  timeBurn: { totalMs: 0, avgMsPerDay: 0, previousAvgMsPerDay: 0, days: [] },
  parentTasks: { doneCount: 0, avgDurationMs: 0, medianDurationMs: 0, notMeasurableCount: 0 },
  fastestTask: null,
  slowestTask: null,
  throughput: { donePerDay: [], wipCount: 0, blockedCount: 0 },
});

const byProjectFixture: StatsByProject = {
  projects: [
    {
      projectId: "project-1",
      name: "Board UI",
      doneCount: 4,
      avgDurationMs: 6 * HOUR,
      medianDurationMs: 5 * HOUR,
      timeSpentMs: 20 * HOUR,
      spendCents: 12_00,
      costPerDoneTaskCents: 3_00,
    },
  ],
};

const totals = (input: number, output: number, runs: number) => ({
  inputTokens: input,
  cachedInputTokens: 0,
  outputTokens: output,
  totalTokens: input + output,
  costCents: 0,
  runCount: runs,
});

const tokenUsageFixture: StatsTokenUsage = {
  generatedAt: "2026-09-29T12:00:00.000Z",
  activeAccountLabel: "levelup@grappus.com",
  windows: [
    { window: "1d", hours: 24, since: "2026-09-28T12:00:00.000Z", totals: totals(0, 0, 0), accounts: [], agents: [] },
    {
      window: "7d",
      hours: 168,
      since: "2026-09-22T12:00:00.000Z",
      totals: totals(3_000_000, 300_000, 3),
      accounts: [
        {
          accountLabel: "levelup@grappus.com",
          provider: "anthropic",
          ...totals(2_000_000, 200_000, 2),
          agents: [{ agentId: "agent-1", agentName: "PaperClipFixer", ...totals(2_000_000, 200_000, 2) }],
        },
        {
          accountLabel: "minion@unberry.com",
          provider: "anthropic",
          ...totals(1_000_000, 100_000, 1),
          agents: [{ agentId: "agent-2", agentName: "Clarifier", ...totals(1_000_000, 100_000, 1) }],
        },
      ],
      agents: [
        { agentId: "agent-1", agentName: "PaperClipFixer", ...totals(2_000_000, 200_000, 2) },
        { agentId: "agent-2", agentName: "Clarifier", ...totals(1_000_000, 100_000, 1) },
      ],
    },
  ],
};

describe("Stats page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Stats />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    statsApiMocks.overview.mockResolvedValue(overviewFixture());
    statsApiMocks.byProject.mockResolvedValue(byProjectFixture);
    statsApiMocks.tokenUsage.mockResolvedValue(tokenUsageFixture);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows token usage per cloud account and agent, with the active login and a window switch", async () => {
    await render();
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Token usage by cloud account");
      });
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Runs currently land on levelup@grappus.com.");
    expect(text).toContain("levelup@grappus.com · active");
    expect(text).toContain("minion@unberry.com");
    expect(text).toContain("PaperClipFixer");
    expect(text).toContain("Clarifier");
    expect(text).toContain("2.2M");
    expect(text).toContain("3.3M");

    const oneDay = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "1 day")!;
    await act(async () => {
      oneDay.click();
    });
    expect(container.textContent).toContain("No token usage recorded in this window.");
  });

  it("renders every metric once both endpoints resolve", async () => {
    await render();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Project performance");
      });
    });

    // burn rate, its comparison against the previous period, and the footnote
    expect(container.textContent).toContain("Agent time per day");
    expect(container.textContent).toContain("3h");
    expect(container.textContent).toContain("50% more than the previous period");
    expect(container.textContent).toContain("Runs that never finished are not counted.");

    // parent-task durations, including the not-measurable caveat
    expect(container.textContent).toContain("Average per task");
    expect(container.textContent).toContain("4h median · 7 done");
    expect(container.textContent).toContain("2 completed tasks have no usable clock");

    // throughput tiles
    expect(container.textContent).toContain("In progress");
    expect(container.textContent).toContain("Blocked");

    // fastest and slowest, each linking to its issue
    expect(container.textContent).toContain("Fastest task");
    expect(container.textContent).toContain("GRA-10 · Fix the login copy");
    expect(container.textContent).toContain("GRA-11 · Rebuild the billing export");
    expect(container.querySelector('a[href="/issues/GRA-10"]')).toBeTruthy();
    expect(container.querySelector('a[href="/issues/GRA-11"]')).toBeTruthy();

    // project performance row
    expect(container.textContent).toContain("Board UI");
    expect(container.textContent).toContain("$12.00");

    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Stats" }]);
  });

  it("shows the empty state, and does not crash, when the range holds no measurable work", async () => {
    statsApiMocks.overview.mockResolvedValue(emptyOverview);
    statsApiMocks.byProject.mockResolvedValue({ projects: [] });

    await render();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("No delivery data in this range.");
      });
    });
    expect(container.textContent).not.toContain("Project performance");
    expect(container.textContent).toContain("Stats");
  });

  it("keeps rendering the rest of the page when no task has a measurable duration", async () => {
    statsApiMocks.overview.mockResolvedValue(overviewFixture({ fastestTask: null, slowestTask: null }));

    await render();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Project performance");
      });
    });
    expect(container.textContent).toContain("Fastest task");
    expect(container.textContent).toContain("Slowest task");
    expect(container.textContent).toContain("No task in this range has a measurable start-to-done time.");
    expect(container.querySelector('a[href^="/issues/"]')).toBeFalsy();
  });

  it("shows the loading skeleton while the endpoints are in flight", async () => {
    statsApiMocks.overview.mockReturnValue(new Promise(() => {}));
    statsApiMocks.byProject.mockReturnValue(new Promise(() => {}));

    await render();

    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Project performance");
  });

  it("refetches both endpoints with the new range when a preset is picked", async () => {
    await render();

    await act(async () => {
      await vi.waitFor(() => expect(statsApiMocks.overview).toHaveBeenCalledTimes(1));
    });
    const [, initialFrom] = statsApiMocks.overview.mock.calls[0] as [string, string];

    const sevenDayButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Last 7 Days",
    );
    expect(sevenDayButton).toBeTruthy();

    await act(async () => {
      sevenDayButton!.click();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(statsApiMocks.overview).toHaveBeenCalledTimes(2);
        expect(statsApiMocks.byProject).toHaveBeenCalledTimes(2);
      });
    });
    const [, nextFrom] = statsApiMocks.overview.mock.calls[1] as [string, string];
    expect(nextFrom).not.toBe(initialFrom);
    expect(new Date(nextFrom).getTime()).toBeGreaterThan(new Date(initialFrom).getTime());
  });
});
