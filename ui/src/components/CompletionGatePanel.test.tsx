// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COMPLETION_EVIDENCE_POLICY,
  type CompletionEvidencePolicy,
} from "@paperclipai/shared";
import { CompletionGatePanel } from "./CompletionGatePanel";
import { TooltipProvider } from "./ui/tooltip";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  if (typeof reactAct === "function") {
    await reactAct(callback);
    return;
  }
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function renderPanel(
  policy: CompletionEvidencePolicy = DEFAULT_COMPLETION_EVIDENCE_POLICY,
  onChange = vi.fn(),
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <TooltipProvider>
        <CompletionGatePanel policy={policy} onChange={onChange} />
      </TooltipProvider>,
    );
  });
  return { host: container, onChange };
}

function triggerText(host: HTMLElement, testId: string): string {
  const trigger = host.querySelector(`[data-testid="${testId}"]`);
  expect(trigger).toBeTruthy();
  return (trigger?.textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("CompletionGatePanel", () => {
  it("shows the shipped default as off, and says so rather than implying protection", () => {
    const { host } = renderPanel();

    const toggle = host.querySelector('[data-testid="completion-gate-enabled-toggle"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[data-testid="completion-gate-inactive-note"]')?.textContent).toContain(
      "nothing is blocked",
    );
  });

  it("keeps the rule visible while the gate is off", () => {
    // An administrator has to be able to read the exact rule before turning it
    // on; hiding the terms until it is live is how a board gets wedged.
    const { host } = renderPanel();

    expect(triggerText(host, "completion-gate-scope")).toBe("Every task");
    expect(triggerText(host, "completion-gate-require")).toBe("A pull request or an artifact");
    expect(triggerText(host, "completion-gate-count-descendants")).toBe(
      "Count evidence on subtasks",
    );
  });

  it("renders a stored non-default policy", () => {
    const { host } = renderPanel({
      enabled: true,
      scope: "parents",
      require: "both",
      countDescendants: false,
    });

    expect(
      host.querySelector('[data-testid="completion-gate-enabled-toggle"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(triggerText(host, "completion-gate-scope")).toBe("Tasks with subtasks");
    expect(triggerText(host, "completion-gate-require")).toBe("A pull request and an artifact");
    expect(triggerText(host, "completion-gate-count-descendants")).toBe("Own evidence only");
    expect(host.querySelector('[data-testid="completion-gate-inactive-note"]')).toBeNull();
  });

  it("emits a whole policy when the switch is flipped, not a partial patch", () => {
    const { host, onChange } = renderPanel({
      enabled: false,
      scope: "roots",
      require: "both",
      countDescendants: false,
    });

    const toggle = host.querySelector('[data-testid="completion-gate-enabled-toggle"]');
    act(() => {
      (toggle as HTMLElement).click();
    });

    // The other three fields must survive the flip; sending `{ enabled: true }`
    // alone would fail the strict schema on the server.
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      scope: "roots",
      require: "both",
      countDescendants: false,
    });
  });

  it("explains what counts as evidence and that a branch does not", () => {
    const copy = renderPanel().host.textContent ?? "";

    expect(copy).toContain("pull request");
    expect(copy).toContain("artifact");
    expect(copy).toContain("A branch or a commit does not count");
    expect(copy).toContain("never available to an agent");
  });

  it("surfaces a save failure instead of leaving the control looking saved", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <TooltipProvider>
          <CompletionGatePanel
            policy={DEFAULT_COMPLETION_EVIDENCE_POLICY}
            onChange={vi.fn()}
            errorMessage="Failed to save the completion gate"
          />
        </TooltipProvider>,
      );
    });

    expect(container.querySelector('[data-testid="completion-gate-error"]')?.textContent).toBe(
      "Failed to save the completion gate",
    );
  });
});
