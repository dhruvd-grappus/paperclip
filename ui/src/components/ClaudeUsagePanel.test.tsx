// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeUsagePanel } from "./ClaudeUsagePanel";

const mockCostsApi = vi.hoisted(() => ({ quotaWindows: vi.fn() }));
vi.mock("../api/costs", () => ({ costsApi: mockCostsApi }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><ClaudeUsagePanel companyId="c1" /></QueryClientProvider>);
  });
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("ClaudeUsagePanel", () => {
  it("shows which Claude account the usage belongs to", async () => {
    mockCostsApi.quotaWindows.mockResolvedValue([{
      provider: "anthropic", ok: true, source: "anthropic-oauth",
      windows: [{ label: "Current session", usedPercent: 64, resetsAt: null, valueLabel: null, detail: null }],
      account: { email: "ankitseniaray01@gmail.com", plan: "max", orgName: "Org" },
    }]);
    await render();
    expect(container!.querySelector('[data-testid="dashboard-claude-account"]')?.textContent)
      .toBe("ankitseniaray01@gmail.com · Max");
    expect(container!.textContent).toContain("Current session");
  });

  it("omits the account when the server does not know it", async () => {
    mockCostsApi.quotaWindows.mockResolvedValue([{ provider: "anthropic", ok: false, error: "no login", windows: [] }]);
    await render();
    expect(container!.querySelector('[data-testid="dashboard-claude-account"]')).toBeNull();
  });
});
