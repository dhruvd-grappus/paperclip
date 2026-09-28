// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceUpdates } from "./InstanceUpdates";

const mockInstanceBuildApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceUpdateApi = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn() }));
const mockInstanceProvidersApi = vi.hoisted(() => ({ get: vi.fn(), act: vi.fn() }));
vi.mock("@/api/instanceBuild", () => ({
  instanceBuildApi: mockInstanceBuildApi,
  instanceUpdateApi: mockInstanceUpdateApi,
}));
vi.mock("../api/instanceBuild", () => ({
  instanceBuildApi: mockInstanceBuildApi,
  instanceUpdateApi: mockInstanceUpdateApi,
}));
vi.mock("../api/instanceProviders", () => ({ instanceProvidersApi: mockInstanceProvidersApi }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("InstanceUpdates", () => {
  it("shows the running build, the update check and the providers panel", async () => {
    mockInstanceBuildApi.get.mockResolvedValue({
      commit: "90c66cab6fd8adee925bfc15c05f39d95944f456",
      shortCommit: "90c66cab6",
      base: "2026.916.1",
      build: "2",
      branch: "grappus/stable",
      builtAt: "2026-09-27T10:00:00.000Z",
      repositoryUrl: "https://github.com/dhruvd-grappus/paperclip",
      commits: [],
    });
    mockInstanceUpdateApi.get.mockResolvedValue({
      enabled: true,
      canUpdate: true,
      updateAvailable: false,
      latest: null,
      status: null,
    });
    mockInstanceProvidersApi.get.mockResolvedValue({
      enabled: true,
      canManage: true,
      agentRuntime: {
        claudeCode: { installed: "2.1.263", latest: "2.1.283" },
        sdk: { installed: "0.3.263", latest: null },
        acpBridge: { installed: "0.73.0", latest: null },
      },
      hostCli: { installed: "2.1.283", latest: "2.1.283" },
      effort: { level: "low", levels: ["default", "low", "high"] },
      status: null,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <InstanceUpdates />
        </QueryClientProvider>,
      );
    });

    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(container.textContent).toContain("Running 90c66cab6");
    expect(container.querySelector("[data-testid='sidebar-build-check']")).not.toBeNull();
    expect(container.querySelector("[data-testid='sidebar-providers']")).not.toBeNull();
  });
});
