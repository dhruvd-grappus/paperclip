import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  ISSUES_ROW_PRESENTATION,
  ISSUES_TOOLBAR_PRESENTATION,
  buildIssuesSearchUrl,
  parseIssueStatusParams,
  applyIssueAttentionParam,
  getNextIssuesPageOffset,
  mergeIssuePagesStable,
  resolveIssuesPresentation,
} from "./Issues";

function createIssue(id: string, title: string): Issue {
  return { id, title } as Issue;
}

describe("buildIssuesSearchUrl", () => {
  it("preserves trailing spaces in the synced search param", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug", "bug ")).toBe("/issues?q=bug+");
  });

  it("removes the search param when the input is cleared", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug#details", "")).toBe("/issues#details");
  });

  it("returns null when the URL already matches the current search", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug+", "bug ")).toBeNull();
  });
});

describe("parseIssueStatusParams", () => {
  it("reads a single status, the shape the dashboard cards link with", () => {
    expect(parseIssueStatusParams(["human_approved"])).toEqual(["human_approved"]);
  });

  it("accepts a comma list and the param repeated, without duplicates", () => {
    expect(parseIssueStatusParams(["done, human_approved", "done"])).toEqual(["done", "human_approved"]);
  });

  it("drops values that are not statuses instead of emptying the list", () => {
    expect(parseIssueStatusParams(["human_approved", "not_a_status"])).toEqual(["human_approved"]);
    expect(parseIssueStatusParams(["nonsense"])).toEqual([]);
  });

  it("returns nothing when the param is absent", () => {
    expect(parseIssueStatusParams([])).toEqual([]);
  });
});

describe("applyIssueAttentionParam", () => {
  const stalledReview = { id: "a", status: "in_review", reviewAttention: { state: "stalled" } };
  const liveReview = { id: "b", status: "in_review", reviewAttention: { state: "covered" } };
  const stuckBlocker = { id: "c", status: "blocked", blockerAttention: { state: "needs_attention" } };
  const finished = { id: "d", status: "done", reviewAttention: { state: "stalled" } };
  const all = [stalledReview, liveReview, stuckBlocker, finished] as never[];

  it("keeps only tasks with no live path, matching the dashboard card's count", () => {
    expect(applyIssueAttentionParam(all, "needs_attention").map((issue) => (issue as { id: string }).id))
      .toEqual(["a", "c"]);
  });

  it("passes the list through when the param is absent or unknown", () => {
    expect(applyIssueAttentionParam(all, null)).toBe(all);
    expect(applyIssueAttentionParam(all, "something_else")).toBe(all);
  });
});

describe("issues page pagination helpers", () => {
  it("opts the Tasks route into the canonical shared task-row presentation", () => {
    expect(ISSUES_ROW_PRESENTATION).toBe("task");
  });

  it("opts the Tasks route into the shared collection toolbar", () => {
    expect(ISSUES_TOOLBAR_PRESENTATION).toBe("collection");
  });

  it("restores the retained legacy list and toolbar when Streamlined UI is off", () => {
    expect(resolveIssuesPresentation(false)).toEqual({
      rowPresentation: "legacy",
      toolbarPresentation: "legacy",
    });
    expect(resolveIssuesPresentation(true)).toEqual({
      rowPresentation: "task",
      toolbarPresentation: "collection",
    });
  });

  it("advances to the next offset when the current page is full", () => {
    expect(getNextIssuesPageOffset(100, 0)).toBe(100);
    expect(getNextIssuesPageOffset(100, 100)).toBe(200);
    expect(getNextIssuesPageOffset(1000, 2000, 1000)).toBe(3000);
  });

  it("stops requesting issue pages when the current page is partial", () => {
    expect(getNextIssuesPageOffset(99, 0)).toBeUndefined();
    expect(getNextIssuesPageOffset(999, 2000, 1000)).toBeUndefined();
  });

  it("dedupes overlapping pages without moving the original issue position", () => {
    const first = createIssue("issue-1", "Original first");
    const second = createIssue("issue-2", "Second");
    const duplicateFirst = createIssue("issue-1", "Duplicate first");
    const third = createIssue("issue-3", "Third");

    expect(mergeIssuePagesStable([[first, second], [duplicateFirst, third]])).toEqual([
      first,
      second,
      third,
    ]);
  });
});
