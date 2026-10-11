import { describe, expect, it } from "vitest";
import { createReportedProblemSchema } from "./reported-problems.js";

describe("createReportedProblemSchema", () => {
  it("accepts a minimal report with title", () => {
    const result = createReportedProblemSchema.safeParse({ title: "Broken preview" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.title).toBe("Broken preview");
    expect(result.success && result.data.commentIds).toEqual([]);
  });

  it("defaults description and commentIds", () => {
    const result = createReportedProblemSchema.safeParse({ title: "x" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.description).toBe("");
    expect(result.success && result.data.commentIds).toEqual([]);
  });

  it("rejects a blank title", () => {
    expect(createReportedProblemSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(createReportedProblemSchema.safeParse({}).success).toBe(false);
  });

  it("accepts sourceIssueId and commentIds", () => {
    const result = createReportedProblemSchema.safeParse({
      title: "t",
      description: "d",
      sourceIssueId: "0a4f79c2-5e9e-4d6b-9c6b-1e8a5f3b7c2d",
      commentIds: ["1a4f79c2-5e9e-4d6b-9c6b-1e8a5f3b7c2d"],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.commentIds).toHaveLength(1);
  });

  it("rejects a non-uuid comment id", () => {
    const result = createReportedProblemSchema.safeParse({ title: "t", commentIds: ["not-a-uuid"] });
    expect(result.success).toBe(false);
  });
});
