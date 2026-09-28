import type { AttentionItem, Issue } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { waitingOnHumanRows } from "./waiting-on-human";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function item(overrides: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    companyId: "company-1",
    sourceKind: "issue_thread_interaction",
    subject: { kind: "interaction", id: "int-1", companyId: "company-1", title: null, identifier: null, href: null },
    whyNow: "Waiting on a decision",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: `interaction:${overrides.id}`,
    dismissalKey: `interaction:${overrides.id}`,
    dismissal: null,
    severity: "high",
    rank: 1,
    activityAt: minutesAgo(10),
    createdAt: minutesAgo(10),
    updatedAt: minutesAgo(10),
    relatedIssue: null,
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
    detail: { kind: "questions", questionCount: 1, firstQuestionText: "Which auth provider?", images: [] },
    trainingExampleId: null,
    ...overrides,
  } as unknown as AttentionItem;
}

function relatedIssue(id: string, identifier: string, title: string) {
  return {
    kind: "issue" as const,
    id,
    companyId: "company-1",
    title,
    identifier,
    status: "in_progress",
    href: `/issues/${identifier}`,
  };
}

function issue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    status: "in_review",
    title: "A task",
    identifier: "GRA-1",
    updatedAt: new Date(NOW - 60_000),
    reviewAttention: { state: "covered", paths: [{ kind: "human_reviewer" }], reason: null },
    ...overrides,
  } as unknown as Issue;
}

describe("waitingOnHumanRows", () => {
  it("lists pending questions and confirmations against their task", () => {
    const rows = waitingOnHumanRows(
      [
        item({ id: "q", relatedIssue: relatedIssue("issue-1", "GRA-10", "Pick a provider") }),
        item({
          id: "c",
          relatedIssue: relatedIssue("issue-2", "GRA-11", "Ship the migration"),
          detail: { kind: "confirmation", promptExcerpt: "Run the migration?", isPlanTarget: false, images: [] },
        }),
      ],
      [],
      NOW,
    );
    expect(rows.map((row) => [row.identifier, row.reasons])).toEqual([
      ["GRA-10", ["question"]],
      ["GRA-11", ["confirmation"]],
    ]);
    expect(rows[0].detail).toBe("1 question — “Which auth provider?”");
    expect(rows[0].href).toBe("/issues/GRA-10");
  });

  it("treats plan approvals, checkbox confirmations and verdicts as confirmations", () => {
    const kinds = [
      { kind: "plan_approval", planTitle: "Plan", summaryExcerpt: null, images: [] },
      { kind: "checkbox_confirmation", optionCount: 2, promptExcerpt: "Pick", images: [] },
      { kind: "item_verdicts", itemCount: 3, promptExcerpt: "Judge", images: [] },
    ];
    const rows = waitingOnHumanRows(
      kinds.map((detail, index) =>
        item({
          id: `i${index}`,
          relatedIssue: relatedIssue(`issue-${index}`, `GRA-2${index}`, "Task"),
          detail: detail as AttentionItem["detail"],
        }),
      ),
      [],
      NOW,
    );
    expect(rows.every((row) => row.reasons[0] === "confirmation")).toBe(true);
  });

  it("ignores suggested tasks and non-interaction sources", () => {
    const rows = waitingOnHumanRows(
      [
        item({
          id: "s",
          relatedIssue: relatedIssue("issue-1", "GRA-10", "Task"),
          detail: { kind: "suggested_tasks", taskCount: 2, firstTaskTitle: "Do it", images: [] } as AttentionItem["detail"],
        }),
        item({
          id: "f",
          sourceKind: "failed_run",
          relatedIssue: relatedIssue("issue-2", "GRA-11", "Task"),
          detail: { kind: "failed_run", agentName: "Bot", failureReasonExcerpt: "exit 1", images: [] } as AttentionItem["detail"],
        }),
      ],
      [],
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("drops cards addressed to an agent, keeps human-only and user-addressed ones", () => {
    const rows = waitingOnHumanRows(
      [
        item({
          id: "agent-card",
          relatedIssue: relatedIssue("issue-1", "GRA-10", "Agent's to answer"),
          resolverAudience: { addresseeAgentId: "agent-9", addresseeUserId: null, effectiveResolverPolicy: "anyone" },
        } as Partial<AttentionItem> & { id: string }),
        item({
          id: "human-only",
          relatedIssue: relatedIssue("issue-2", "GRA-11", "Human only"),
          resolverAudience: { addresseeAgentId: "agent-9", addresseeUserId: null, effectiveResolverPolicy: "human_only" },
        } as Partial<AttentionItem> & { id: string }),
        item({
          id: "user-card",
          relatedIssue: relatedIssue("issue-3", "GRA-12", "Addressed to a user"),
          resolverAudience: { addresseeAgentId: "agent-9", addresseeUserId: "user-1", effectiveResolverPolicy: "anyone" },
        } as Partial<AttentionItem> & { id: string }),
      ],
      [],
      NOW,
    );
    expect(rows.map((row) => row.identifier)).toEqual(["GRA-11", "GRA-12"]);
  });

  it("skips rows the user dismissed, snoozed or archived", () => {
    const rows = waitingOnHumanRows(
      [
        item({ id: "d", relatedIssue: relatedIssue("i1", "GRA-1", "T"), dismissal: { dismissedAt: minutesAgo(1) } as AttentionItem["dismissal"] }),
        item({ id: "s", relatedIssue: relatedIssue("i2", "GRA-2", "T"), snoozedUntil: new Date(NOW + 60_000).toISOString() }),
        item({ id: "a", relatedIssue: relatedIssue("i3", "GRA-3", "T"), archivedAt: minutesAgo(1) }),
        item({ id: "expired-snooze", relatedIssue: relatedIssue("i4", "GRA-4", "T"), snoozedUntil: minutesAgo(1) }),
      ],
      [],
      NOW,
    );
    expect(rows.map((row) => row.identifier)).toEqual(["GRA-4"]);
  });

  it("includes in-review tasks waiting on a person and skips agent-carried reviews", () => {
    const rows = waitingOnHumanRows(
      [],
      [
        issue({ id: "i1", identifier: "GRA-30" }),
        issue({ id: "i2", identifier: "GRA-31", reviewAttention: { state: "covered", paths: [{ kind: "active_run" }], reason: null } } as Partial<Issue> & { id: string }),
        issue({ id: "i3", identifier: "GRA-32", reviewAttention: { state: "stalled", paths: [], reason: null } } as Partial<Issue> & { id: string }),
        issue({ id: "i4", identifier: "GRA-33", status: "in_progress" }),
      ],
      NOW,
    );
    expect(rows.map((row) => row.identifier).sort()).toEqual(["GRA-30", "GRA-32"]);
  });

  it("includes done tasks nobody approved, and not approved or cancelled ones", () => {
    const rows = waitingOnHumanRows(
      [],
      [
        issue({ id: "i1", identifier: "GRA-50", status: "done", completedAt: new Date(NOW - 5 * 60_000) } as Partial<Issue> & { id: string }),
        issue({ id: "i2", identifier: "GRA-51", status: "human_approved" }),
        issue({ id: "i3", identifier: "GRA-52", status: "cancelled" }),
        issue({ id: "i4", identifier: "GRA-53", status: "done", archivedAt: new Date(NOW) } as Partial<Issue> & { id: string }),
      ],
      NOW,
    );
    expect(rows.map((row) => [row.identifier, row.reasons])).toEqual([
      ["GRA-50", ["done_unapproved"]],
    ]);
    // Waiting since it finished, not since its last edit.
    expect(rows[0].waitingSince).toBe(minutesAgo(5));
  });

  it("lists parent tasks only, dropping subtask reviews and subtask cards", () => {
    const rows = waitingOnHumanRows(
      [
        item({ id: "child-card", relatedIssue: relatedIssue("child-1", "GRA-61", "Subtask asking") }),
        item({ id: "parent-card", relatedIssue: relatedIssue("parent-1", "GRA-60", "Parent asking") }),
        item({ id: "unknown-card", relatedIssue: relatedIssue("not-in-list", "GRA-62", "Task off the list") }),
      ],
      [
        issue({ id: "parent-1", identifier: "GRA-60", parentId: null } as Partial<Issue> & { id: string }),
        issue({ id: "child-1", identifier: "GRA-61", parentId: "parent-1" } as Partial<Issue> & { id: string }),
        issue({ id: "child-2", identifier: "GRA-63", parentId: "parent-1", status: "done" } as Partial<Issue> & { id: string }),
      ],
      NOW,
    );
    expect(rows.map((row) => row.identifier).sort()).toEqual(["GRA-60", "GRA-62"]);
  });

  it("carries the task owner: originator first, then responsible, then assignee", () => {
    const rows = waitingOnHumanRows(
      [item({ id: "q", relatedIssue: relatedIssue("i-feed", "GRA-70", "Asking") })],
      [
        issue({ id: "i-feed", identifier: "GRA-70", createdByUserId: "user-creator" } as Partial<Issue> & { id: string }),
        issue({ id: "i-resp", identifier: "GRA-71", createdByUserId: null, responsibleUserId: "user-resp" } as Partial<Issue> & { id: string }),
        issue({ id: "i-assignee", identifier: "GRA-72", createdByUserId: null, assigneeUserId: "user-assignee" } as Partial<Issue> & { id: string }),
        issue({ id: "i-agent", identifier: "GRA-73", createdByUserId: null } as Partial<Issue> & { id: string }),
      ],
      NOW,
    );
    const owners = new Map(rows.map((row) => [row.identifier, row.ownerUserId]));
    // A feed row has no owner of its own; it takes the task's.
    expect(owners.get("GRA-70")).toBe("user-creator");
    expect(owners.get("GRA-71")).toBe("user-resp");
    expect(owners.get("GRA-72")).toBe("user-assignee");
    expect(owners.get("GRA-73")).toBeNull();
  });

  it("leaves the owner null for a card on a task the list does not cover", () => {
    const rows = waitingOnHumanRows(
      [item({ id: "q", relatedIssue: relatedIssue("not-in-list", "GRA-74", "Asking") })],
      [],
      NOW,
    );
    expect(rows[0].ownerUserId).toBeNull();
  });

  it("folds a pending card and its review into one row, oldest wait first", () => {
    const rows = waitingOnHumanRows(
      [
        item({
          id: "c",
          activityAt: minutesAgo(90),
          createdAt: minutesAgo(90),
          relatedIssue: relatedIssue("issue-1", "GRA-40", "In review and asking"),
          detail: { kind: "confirmation", promptExcerpt: "Merge?", isPlanTarget: false, images: [] },
        }),
        item({ id: "q", activityAt: minutesAgo(5), createdAt: minutesAgo(5), relatedIssue: relatedIssue("issue-2", "GRA-41", "Newer question") }),
      ],
      [issue({ id: "issue-1", identifier: "GRA-40", title: "In review and asking", updatedAt: new Date(NOW - 30 * 60_000) })],
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].identifier).toBe("GRA-40");
    expect(rows[0].reasons).toEqual(["confirmation", "in_review"]);
    // Oldest signal on the task is what it has been waiting on.
    expect(rows[0].waitingSince).toBe(minutesAgo(90));
    expect(rows[1].identifier).toBe("GRA-41");
  });
});
