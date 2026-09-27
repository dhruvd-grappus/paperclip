// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarBuildUpdate } from "./SidebarBuildUpdate";

const mockInstanceBuildApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceUpdateApi = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn() }));
vi.mock("../api/instanceBuild", () => ({ instanceBuildApi: mockInstanceBuildApi, instanceUpdateApi: mockInstanceUpdateApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const build = {
  commit: "82744b4733ea0000000000000000000000000000", shortCommit: "82744b473", base: "2026.916.1", build: "3",
  branch: "grappus/stable", builtAt: null, repositoryUrl: "https://github.com/dhruvd-grappus/paperclip", commits: [],
};
const latest = {
  tag: "overlay-2138d93848bd", sha: "2138d93848bd", build: "5", name: "2026.916.1-grappus.5 (2138d93848bd)",
  notes: "", publishedAt: null, url: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><SidebarBuildUpdate build={build} /></QueryClientProvider>);
  });
  await settle();
}

const text = () => container?.textContent ?? "";
const click = async (testId: string) => {
  await act(async () => { container!.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); });
  await settle();
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("SidebarBuildUpdate", () => {
  it("queues the latest build for an instance admin and shows progress", async () => {
    mockInstanceUpdateApi.get.mockResolvedValue({
      enabled: true, canUpdate: true, latest, updateAvailable: true, status: null, error: null,
    });
    mockInstanceUpdateApi.request.mockResolvedValue({ state: "queued", tag: latest.tag, message: null, updatedAt: null });
    await render();
    expect(text()).toContain("Build 5 is available (2138d9384)");

    mockInstanceUpdateApi.get.mockResolvedValue({
      enabled: true, canUpdate: true, latest, updateAvailable: true, error: null,
      status: { state: "waiting_idle", tag: latest.tag, message: "1 agent run live", updatedAt: null },
    });
    mockInstanceBuildApi.get.mockResolvedValue(build);
    await click("sidebar-build-update-now");
    expect(mockInstanceUpdateApi.request).toHaveBeenCalledWith("overlay-2138d93848bd");
    expect(text()).toContain("Waiting for running agent tasks to finish — 1 agent run live");
  });

  it("tells a non-admin to ask an admin, and says up to date after a check", async () => {
    mockInstanceUpdateApi.get.mockResolvedValue({
      enabled: true, canUpdate: false, latest, updateAvailable: true, status: null, error: null,
    });
    await render();
    expect(text()).toContain("Ask an instance admin to update.");
    expect(container!.querySelector('[data-testid="sidebar-build-update-now"]')).toBeNull();
    act(() => root?.unmount());
    container?.remove();

    mockInstanceUpdateApi.get.mockResolvedValue({
      enabled: true, canUpdate: true, latest: { ...latest, sha: "82744b4733ea" }, updateAvailable: false, status: null, error: null,
    });
    await render();
    await click("sidebar-build-check");
    expect(mockInstanceUpdateApi.get).toHaveBeenLastCalledWith(true);
    expect(text()).toContain("You are on the latest build.");
  });

  it("renders nothing on an upstream build", async () => {
    mockInstanceUpdateApi.get.mockResolvedValue({ enabled: false });
    await render();
    expect(container!.querySelector('[data-testid="sidebar-build-update"]')).toBeNull();
  });
});
