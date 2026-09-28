// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProviders } from "./SidebarProviders";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), act: vi.fn() }));
vi.mock("../api/instanceProviders", () => ({ instanceProvidersApi: mockApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  enabled: true,
  canManage: true,
  agentRuntime: {
    sdk: { installed: "0.3.263", latest: "0.3.283" },
    claudeCode: { installed: "2.1.263", latest: "2.1.283" },
    acpBridge: { installed: "0.73.0", latest: "0.81.2" },
    pinned: true,
  },
  hostCli: { installed: "2.1.281", latest: "2.1.283" },
  effort: { level: "low", levels: ["default", "low", "medium", "high", "xhigh", "max"] },
  status: null,
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
    root!.render(<QueryClientProvider client={client}><SidebarProviders /></QueryClientProvider>);
  });
  await settle();
}

const text = () => container?.textContent ?? "";

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("SidebarProviders", () => {
  it("shows runtime and host CLI versions against npm, and the effort level", async () => {
    mockApi.get.mockResolvedValue(base);
    await render();
    expect(text()).toContain("Claude Code (agent runs)");
    expect(text()).toContain("2.1.263");
    expect(text()).toContain("2.1.283 on npm");
    expect(text()).toContain("pinned by the runner");
    expect(text()).toContain("Low");
    expect(text()).toContain("Claude Code CLI 2.1.283 is available.");
  });

  it("queues a host CLI update for an instance admin", async () => {
    mockApi.get.mockResolvedValue(base);
    mockApi.act.mockResolvedValue({ state: "queued", action: "update_claude_cli", message: null, updatedAt: null });
    await render();
    const button = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Update CLI")!;
    await act(async () => { button.click(); });
    await settle();
    expect(mockApi.act).toHaveBeenCalledWith({ action: "update_claude_cli" });
  });

  it("is read-only for members and hidden on upstream builds", async () => {
    mockApi.get.mockResolvedValue({ ...base, canManage: false });
    await render();
    expect(text()).toContain("Only instance admins can change these.");
    expect(text()).not.toContain("Update CLI");
    act(() => root?.unmount());
    container?.remove();
    mockApi.get.mockResolvedValue({ enabled: false, canManage: false });
    await render();
    expect(container!.querySelector('[data-testid="sidebar-providers"]')).toBeNull();
  });
});
