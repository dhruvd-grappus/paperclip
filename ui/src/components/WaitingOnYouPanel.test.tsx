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

  function render(items: AttentionItem[], issues: Issue[]) {
    flushSync(() => {
      root.render(<WaitingOnYouPanel attentionItems={items} issues={issues} />);
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

  it("collapses a long list behind a link to the task list", () => {
    render(
      Array.from({ length: 10 }, (_, i) => interactionItem(`GRA-${i}`, `Task ${i}`)),
      [],
    );
    expect(container.textContent).toContain("+2 more");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/issues");
  });
});
