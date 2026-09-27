// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarBuildInfo } from "./SidebarBuildInfo";

const mockInstanceBuildApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/instanceBuild", () => ({ instanceBuildApi: mockInstanceBuildApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const forkBuild = {
  commit: "90c66cab6fd8adee925bfc15c05f39d95944f456",
  shortCommit: "90c66cab6",
  base: "2026.916.1",
  build: "2",
  branch: "grappus/stable",
  builtAt: "2026-09-27T10:00:00.000Z",
  repositoryUrl: "https://github.com/dhruvd-grappus/paperclip",
  commits: [
    {
      sha: "90c66cab6fd8adee925bfc15c05f39d95944f456",
      shortSha: "90c66cab6",
      subject: "fix(recovery): keep the issue lock while same-run native resumption owns the run",
      body: "Between same-run attempts a native run row already reads failed.",
      author: "Dhruv",
      committedAt: "2026-09-27T15:39:40+05:30",
    },
    {
      sha: "56015624c0000000000000000000000000000000",
      shortSha: "56015624c",
      subject: "fix(runner-goals): take the agent lock before the issue lock in goal projection",
      body: "",
      author: "Dhruv",
      committedAt: "2026-09-27T15:10:00+05:30",
    },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(rail = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <SidebarBuildInfo rail={rail} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  // Let the query settle.
  for (let i = 0; i < 20 && mockInstanceBuildApi.get.mock.results.length === 0; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("SidebarBuildInfo", () => {
  it("shows the running commit and opens the changelog with commit links", async () => {
    mockInstanceBuildApi.get.mockResolvedValue(forkBuild);
    await render();

    const badge = document.querySelector<HTMLButtonElement>('[data-testid="sidebar-build-info"]');
    expect(badge?.textContent).toContain("90c66cab6 · build 2");

    await act(async () => { badge!.click(); });
    const changelog = document.querySelector('[data-testid="sidebar-build-changelog"]');
    expect(changelog?.querySelectorAll("li")).toHaveLength(2);
    expect(changelog?.textContent).toContain("take the agent lock before the issue lock");
    expect(changelog?.textContent).toContain("running");
    const link = changelog?.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe(`https://github.com/dhruvd-grappus/paperclip/commit/${forkBuild.commit}`);
    expect(document.body.textContent).toContain("grappus/stable on upstream v2026.916.1");
  });

  it("shows only the commit for an upstream build and nothing without one", async () => {
    mockInstanceBuildApi.get.mockResolvedValue({
      ...forkBuild, base: null, build: null, branch: null, builtAt: null, repositoryUrl: null, commits: [],
      commit: "d554c4789", shortCommit: "d554c4789",
    });
    await render();
    expect(document.querySelector('[data-testid="sidebar-build-info"]')?.textContent).toBe("d554c4789");
    act(() => root?.unmount());
    container?.remove();

    mockInstanceBuildApi.get.mockResolvedValue({ ...forkBuild, commit: null, shortCommit: null });
    await render();
    expect(document.querySelector('[data-testid="sidebar-build-info"]')).toBeNull();
  });
});
