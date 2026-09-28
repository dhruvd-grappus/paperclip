import { describe, expect, it } from "vitest";
import { checkHumanApprovalTransition } from "../services/completion-gate.ts";

const BOARD = { actorType: "board", actorUserId: "user-1" };
const AGENT = { actorType: "agent", actorUserId: null };

describe("checkHumanApprovalTransition", () => {
  it("lets a board user approve a done task", () => {
    expect(
      checkHumanApprovalTransition({ ...BOARD, fromStatus: "done", toStatus: "human_approved" }),
    ).toBeNull();
  });

  it("refuses an agent, which is the point of the status", () => {
    expect(
      checkHumanApprovalTransition({ ...AGENT, fromStatus: "done", toStatus: "human_approved" }),
    ).toBe("actor_not_human");
  });

  it("refuses a board session with no user behind it", () => {
    // A board-typed actor without a user id is a service caller, not a person.
    expect(
      checkHumanApprovalTransition({
        actorType: "board",
        actorUserId: null,
        fromStatus: "done",
        toStatus: "human_approved",
      }),
    ).toBe("actor_not_human");
  });

  it("refuses approval that skips done", () => {
    for (const fromStatus of ["backlog", "todo", "in_progress", "in_review", "blocked", "cancelled"]) {
      expect(
        checkHumanApprovalTransition({ ...BOARD, fromStatus, toStatus: "human_approved" }),
      ).toBe("not_done");
    }
  });

  it("ignores every other transition, including an agent completing normally", () => {
    expect(
      checkHumanApprovalTransition({ ...AGENT, fromStatus: "in_progress", toStatus: "done" }),
    ).toBeNull();
    expect(
      checkHumanApprovalTransition({ ...AGENT, fromStatus: "in_progress", toStatus: "blocked" }),
    ).toBeNull();
  });

  it("does not re-check a task already approved", () => {
    // A no-op restatement of the current status must not become a refusal, or
    // an agent patching unrelated fields on an approved task would be rejected.
    expect(
      checkHumanApprovalTransition({
        ...AGENT,
        fromStatus: "human_approved",
        toStatus: "human_approved",
      }),
    ).toBeNull();
  });
});
