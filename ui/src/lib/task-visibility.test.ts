import { describe, expect, it } from "vitest";
import { isVisibleTask, isVisibleWorkTask, visibleWorkTasks } from "./task-visibility";

describe("task visibility", () => {
  it("accepts an ordinary task", () => {
    expect(isVisibleWorkTask({})).toBe(true);
  });

  it("rejects hidden, harness and archived tasks", () => {
    expect(isVisibleTask({ hiddenAt: "2026-09-28T00:00:00.000Z" })).toBe(false);
    expect(isVisibleTask({ harnessKind: "smoke" })).toBe(false);
    expect(isVisibleTask({ archivedAt: new Date() })).toBe(false);
  });

  it("keeps chat containers out of work lists, mirroring executionIssueCondition", () => {
    const container = { conversationAgentId: "agent-1" };
    // Visible as a record, but not work anybody does.
    expect(isVisibleTask(container)).toBe(true);
    expect(isVisibleWorkTask(container)).toBe(false);
  });

  it("filters a list without touching the survivors", () => {
    const ordinary = { id: "a", hiddenAt: null };
    const hidden = { id: "b", hiddenAt: new Date() };
    expect(visibleWorkTasks([ordinary, hidden])).toEqual([ordinary]);
  });
});
