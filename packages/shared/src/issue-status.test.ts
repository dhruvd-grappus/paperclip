import { describe, expect, it } from "vitest";
import {
  COMPLETED_ISSUE_STATUSES,
  ISSUE_STATUSES,
  TERMINAL_ISSUE_STATUSES,
  isCompletedIssueStatus,
  isTerminalIssueStatus,
} from "./constants.js";

describe("issue status sets", () => {
  it("carries human_approved as a real status", () => {
    expect(ISSUE_STATUSES).toContain("human_approved");
  });

  it("keeps every terminal and completed status inside ISSUE_STATUSES", () => {
    for (const status of TERMINAL_ISSUE_STATUSES) {
      expect(ISSUE_STATUSES).toContain(status);
    }
    for (const status of COMPLETED_ISSUE_STATUSES) {
      expect(ISSUE_STATUSES).toContain(status);
    }
  });

  it("treats done, human_approved and cancelled as over, and nothing else", () => {
    const terminal = ISSUE_STATUSES.filter(isTerminalIssueStatus);
    expect(terminal).toEqual(["done", "human_approved", "cancelled"]);
  });

  it("counts only done and human_approved as successful completions", () => {
    // cancelled is terminal but is not a completion — throughput must not
    // count abandoned work as shipped.
    expect(isCompletedIssueStatus("cancelled")).toBe(false);
    expect(isTerminalIssueStatus("cancelled")).toBe(true);
    expect(ISSUE_STATUSES.filter(isCompletedIssueStatus)).toEqual(["done", "human_approved"]);
  });

  it("does not treat an unknown or absent status as finished", () => {
    for (const value of [null, undefined, "", "archived", "Done"]) {
      expect(isTerminalIssueStatus(value)).toBe(false);
      expect(isCompletedIssueStatus(value)).toBe(false);
    }
  });
});
