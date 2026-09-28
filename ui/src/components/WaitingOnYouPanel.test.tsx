// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, Issue } from "@paperclipai/shared";
import { WaitingOnYouPanel } from "./WaitingOnYouPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function interactionItem(identifier: string, title: string): AttentionItem {
  return {
    id: `item-${identifier}`,
    companyId: "company-1",
    sourceKind: "issue_thread_interaction",
    subject: { kind: "interaction", id: "int-1", companyId: "company-1", title: null, identifier: null, status: null, href: null },
    whyNow: "Waiting on a decision",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: `interaction:${identifier}`,
    dismissalKey: `interaction:${identifier}`,
    dismissal: null,
    severity: "high",
    rank: 1,
    activityAt: "2026-09-28T10:00:00.000Z",
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    relatedIssue: {
      kind: "issue",
      id: `issue-${identifier}`,
      companyId: "company-1",
      title,
      identifier,
      status: "in_progress",
      href: `/issues/${identifier}`,
    },
    project: null,
    workspace: null,
    expiresAt: null,
    ruleKey: null,
    originAgentName: null,
    queues: [],
    shelf: false,
    retentionDays: 30,
    keep: false,
    archivedAt: null,
    retentionVersion: 1,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    detail: { kind: "questions", questionCount: 1, firstQuestionText: "Which provider?", images: [] },
    trainingExampleId: null,
  } as unknown as AttentionItem;
}

function reviewIssue(identifier: string): Issue {
  return {
    id: `issue-${identifier}`,
    identifier,
    title: `Review ${identifier}`,
    status: "in_review",
    updatedAt: new Date("2026-09-28T11:00:00.000Z"),
    reviewAttention: { state: "covered", paths: [{ kind: "human_reviewer" }], reason: null },
  } as unknown as Issue;
}

function doneIssue(identifier: string): Issue {
  return {
    id: `issue-${identifier}`,
    identifier,
    title: `Finished ${identifier}`,
    status: "done",
    updatedAt: new Date("2026-09-28T11:00:00.000Z"),
    completedAt: new Date("2026-09-28T11:00:00.000Z"),
  } as unknown as Issue;
}

describe("WaitingOnYouPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(
    items: AttentionItem[],
    issues: Issue[],
    props: {
      showAll?: boolean;
      userName?: (userId: string | null | undefined) => string | null;
      onUpdateIssue?: (issueId: string, data: { status: string }) => void;
    } = {},
  ) {
    flushSync(() => {
      root.render(<WaitingOnYouPanel attentionItems={items} issues={issues} {...props} />);
    });
  }

  it("explains itself when nothing is waiting", () => {
    render([], []);
    expect(container.textContent).toContain("No task is waiting on a person");
  });

  it("lists each waiting task with its reason and links to it", () => {
    render([interactionItem("GRA-10", "Pick a provider")], [reviewIssue("GRA-20")]);
    const text = container.textContent ?? "";
    expect(text).toContain("Waiting On You · 2");
    expect(text).toContain("Pick a provider");
    expect(text).toContain("question to answer");
    expect(text).toContain("in review");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/issues/GRA-10");
    expect(hrefs).toContain("/issues/GRA-20");
  });

  it("collapses a long list behind a link to the full waiting-on-you page", () => {
    render(
      Array.from({ length: 10 }, (_, i) => interactionItem(`GRA-${i}`, `Task ${i}`)),
      [],
    );
    expect(container.textContent).toContain("+2 more");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/waiting-on-you");
  });

  it("renders every row and drops the more link when showing all", () => {
    render(
      Array.from({ length: 10 }, (_, i) => interactionItem(`GRA-${i}`, `Task ${i}`)),
      [],
      { showAll: true },
    );
    expect(container.textContent).not.toContain("more");
    expect(container.textContent).toContain("Task 9");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/waiting-on-you");
  });

  it("approves a finished task from the row without leaving the list", () => {
    const changes: Array<[string, { status: string }]> = [];
    const issue = doneIssue("GRA-60");
    render([], [issue], { onUpdateIssue: (issueId, data) => changes.push([issueId, data]) });

    // The picker must not sit inside the row's link, or the anchor takes the
    // click and the popover never opens — the bug this pins down.
    const trigger = container.querySelector("[aria-haspopup]") as HTMLElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger!.closest("a")).toBeNull();

    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // `human_approved` is only offered on a finished task (see
    // `offeredStatuses`), which is exactly the sign-off this desk is for.
    const option = [...document.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("Human Approved"),
    );
    expect(option).toBeDefined();
    flushSync(() => {
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(changes).toEqual([[issue.id, { status: "human_approved" }]]);
  });

  it("lets an in-review row be moved on, without offering sign-off yet", () => {
    const changes: Array<[string, { status: string }]> = [];
    const issue = reviewIssue("GRA-20");
    render([], [issue], { onUpdateIssue: (issueId, data) => changes.push([issueId, data]) });
    const trigger = container.querySelector("[aria-haspopup]") as HTMLElement | null;
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const labels = [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels.some((label) => label.includes("Done"))).toBe(true);
    // A task has to be finished before a person can sign it off.
    expect(labels.some((label) => label.includes("Human Approved"))).toBe(false);

    const done = [...document.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("Done"),
    );
    flushSync(() => {
      done!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(changes).toEqual([[issue.id, { status: "done" }]]);
  });

  it("leaves rows with no known task status read-only", () => {
    const changes: Array<[string, { status: string }]> = [];
    render(
      // A pending card on a task outside the loaded list: nothing to edit.
      [interactionItem("GRA-90", "Off-list card")],
      [],
      { onUpdateIssue: (issueId, data) => changes.push([issueId, data]) },
    );
    expect(container.querySelector("[aria-haspopup]")).toBeNull();
    expect(changes).toEqual([]);
  });

  it("names the owner when the caller can resolve one, and stays quiet otherwise", () => {
    const issues = [{ ...reviewIssue("GRA-20"), createdByUserId: "user-1" } as Issue];
    render([], issues, { userName: (id) => (id === "user-1" ? "Ada" : null) });
    expect(container.textContent).toContain("owner Ada");

    render([], issues);
    expect(container.textContent).not.toContain("owner");
  });
});
