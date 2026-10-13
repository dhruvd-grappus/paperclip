// @vitest-environment jsdom

// Regression guard for GRA-632: the Reported problems page is a board child
// route (`path="reported-problems"` under `:companyPrefix`). It must also be
// registered as a reserved unprefixed redirect so direct links to
// `/reported-problems` resolve to `/<issuePrefix>/reported-problems` instead of
// being parsed as `:companyPrefix="reported-problems"` and 404ing with
// "No organization matches prefix 'REPORTED-PROBLEMS'". This drives the real
// <App> route table so a future removal of the redirect route fails loudly.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papReportedPatched?: boolean;
  };
  if (!sheetProto.__papReportedPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap-reported-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papReportedPatched = true;
  }
});

vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

vi.mock("./pages/ReportedProblems", () => ({
  ReportedProblems: () => <div>REPORTED_PROBLEMS_PAGE</div>,
}));

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

const PAP_COMPANY = {
  id: "company-1",
  name: "Paperclip",
  issuePrefix: "PAP",
  status: "active",
};
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

async function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return root;
}

async function waitForRoute(container: HTMLElement, text: string) {
  await vi.waitFor(() => expect(container.textContent).toContain(text));
}

describe("App Reported problems routing (GRA-632)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("redirects unprefixed /reported-problems to the company-prefixed page", async () => {
    const root = await renderAppAt(container, "/reported-problems");
    await waitForRoute(container, "REPORTED_PROBLEMS_PAGE");
    expect(container.textContent).not.toContain("No organization matches prefix");
    expect(container.textContent).not.toContain("Organization not found");
    flushSync(() => root.unmount());
  });
});
