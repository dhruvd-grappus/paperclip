import { describe, expect, it } from "vitest";
import { completionEvidencePolicyFromStorage } from "./validators/company.js";
import {
  DEFAULT_COMPLETION_EVIDENCE_POLICY,
  describeCompletionGateFailure,
  evaluateCompletionGate,
  hasCompletionEvidence,
  isCompletionEvidence,
  type CompletionEvidencePolicy,
  type CompletionGateSubject,
} from "./completion-evidence.js";

const wp = (type: string, overrides: Record<string, unknown> = {}) =>
  ({ type, url: "https://example.test/x", status: "active", ...overrides }) as never;

describe("isCompletionEvidence", () => {
  it("accepts a pull request, artifact, preview or running service", () => {
    for (const type of ["pull_request", "artifact", "preview_url", "runtime_service"]) {
      expect(isCompletionEvidence(wp(type))).toBe(true);
    }
  });

  it("rejects a branch or a commit — pushing code is not proof it was checked", () => {
    expect(isCompletionEvidence(wp("branch"))).toBe(false);
    expect(isCompletionEvidence(wp("commit"))).toBe(false);
    expect(isCompletionEvidence(wp("document"))).toBe(false);
  });

  it("rejects evidence that no longer stands behind the work", () => {
    expect(isCompletionEvidence(wp("pull_request", { status: "closed" }))).toBe(false);
    expect(isCompletionEvidence(wp("preview_url", { status: "failed" }))).toBe(false);
    expect(isCompletionEvidence(wp("pull_request", { status: "archived" }))).toBe(false);
    // Merged is the good outcome, not a retraction.
    expect(isCompletionEvidence(wp("pull_request", { status: "merged" }))).toBe(true);
  });

  it("requires a link, except for an artifact that carries its location in metadata", () => {
    expect(isCompletionEvidence(wp("pull_request", { url: null }))).toBe(false);
    expect(isCompletionEvidence(wp("preview_url", { url: "" }))).toBe(false);
    expect(isCompletionEvidence(wp("artifact", { url: null }))).toBe(true);
  });
});

describe("hasCompletionEvidence", () => {
  it("is false for no work products and for non-evidence ones only", () => {
    expect(hasCompletionEvidence([])).toBe(false);
    expect(hasCompletionEvidence([wp("branch"), wp("commit")])).toBe(false);
  });

  it("is true as soon as one qualifying work product exists", () => {
    expect(hasCompletionEvidence([wp("branch"), wp("artifact")])).toBe(true);
  });
});

describe("evaluateCompletionGate", () => {
  const subject = (overrides: Partial<CompletionGateSubject> = {}): CompletionGateSubject => ({
    hasChildren: false,
    isRoot: true,
    ownWorkProducts: [],
    ...overrides,
  });

  const policy = (overrides: Partial<CompletionEvidencePolicy> = {}): CompletionEvidencePolicy => ({
    ...DEFAULT_COMPLETION_EVIDENCE_POLICY,
    enabled: true,
    ...overrides,
  });

  it("ships disabled, so an empty task completes untouched", () => {
    expect(DEFAULT_COMPLETION_EVIDENCE_POLICY.enabled).toBe(false);
    const result = evaluateCompletionGate(DEFAULT_COMPLETION_EVIDENCE_POLICY, subject());
    expect(result).toMatchObject({ allowed: true, inScope: false });
  });

  it("blocks an in-scope task with nothing to show", () => {
    expect(evaluateCompletionGate(policy(), subject())).toMatchObject({
      allowed: false,
      inScope: true,
      reason: "missing_any",
    });
  });

  it("under `either`, one qualifying work product is enough", () => {
    expect(
      evaluateCompletionGate(policy(), subject({ ownWorkProducts: [wp("artifact")] })),
    ).toMatchObject({ allowed: true, reason: null });
    expect(
      evaluateCompletionGate(policy(), subject({ ownWorkProducts: [wp("pull_request")] })),
    ).toMatchObject({ allowed: true, reason: null });
  });

  it("under `both`, it names which side is missing", () => {
    const both = policy({ require: "both" });
    expect(
      evaluateCompletionGate(both, subject({ ownWorkProducts: [wp("pull_request")] })),
    ).toMatchObject({ allowed: false, reason: "missing_artifact" });
    expect(
      evaluateCompletionGate(both, subject({ ownWorkProducts: [wp("artifact")] })),
    ).toMatchObject({ allowed: false, reason: "missing_pull_request" });
    expect(
      evaluateCompletionGate(
        both,
        subject({ ownWorkProducts: [wp("pull_request"), wp("preview_url")] }),
      ),
    ).toMatchObject({ allowed: true, reason: null });
  });

  it("scope `parents` leaves a leaf task alone and still checks a parent", () => {
    const parents = policy({ scope: "parents" });
    expect(evaluateCompletionGate(parents, subject({ hasChildren: false }))).toMatchObject({
      allowed: true,
      inScope: false,
    });
    expect(evaluateCompletionGate(parents, subject({ hasChildren: true }))).toMatchObject({
      allowed: false,
      inScope: true,
    });
  });

  it("scope `roots` leaves a child task alone", () => {
    const roots = policy({ scope: "roots" });
    expect(evaluateCompletionGate(roots, subject({ isRoot: false }))).toMatchObject({
      inScope: false,
      allowed: true,
    });
    expect(evaluateCompletionGate(roots, subject({ isRoot: true }))).toMatchObject({
      inScope: true,
      allowed: false,
    });
  });

  it("credits a parent with its children's evidence only when told to", () => {
    const parent = subject({
      hasChildren: true,
      ownWorkProducts: [],
      descendantWorkProducts: [wp("pull_request")],
    });
    // The measured case: an umbrella task owns nothing, its children did the work.
    expect(evaluateCompletionGate(policy({ countDescendants: true }), parent)).toMatchObject({
      allowed: true,
    });
    expect(evaluateCompletionGate(policy({ countDescendants: false }), parent)).toMatchObject({
      allowed: false,
      reason: "missing_any",
    });
  });

  it("reports the evidence it did find, so the error can say what is missing", () => {
    const result = evaluateCompletionGate(
      policy({ require: "both" }),
      subject({ ownWorkProducts: [wp("artifact"), wp("branch")] }),
    );
    expect(result.presentTypes).toEqual(["artifact"]);
  });
});

describe("describeCompletionGateFailure", () => {
  it("names the missing leg and what is already recorded", () => {
    expect(
      describeCompletionGateFailure({
        allowed: false,
        inScope: true,
        reason: "missing_artifact",
        presentTypes: ["pull_request"],
      }),
    ).toBe(
      "This task needs an artifact, preview_url, or runtime_service work product before it can be completed. Recorded so far: pull_request.",
    );
  });

  it("says plainly when nothing at all is recorded", () => {
    const message = describeCompletionGateFailure({
      allowed: false,
      inScope: true,
      reason: "missing_any",
      presentTypes: [],
    });
    expect(message).toContain("No evidence work product is recorded on this task.");
  });
});

describe("completionEvidencePolicyFromStorage", () => {
  it("reads a well-formed stored policy back unchanged", () => {
    const stored = { enabled: true, scope: "parents", require: "both", countDescendants: false };
    expect(completionEvidencePolicyFromStorage(stored)).toEqual(stored);
  });

  it("falls back to the shipped default for anything malformed", () => {
    // Failing open is deliberate: a bad settings row must not make every task
    // in the company uncompletable.
    for (const value of [null, undefined, {}, { enabled: true }, "on", { enabled: true, scope: "everything", require: "both", countDescendants: true }]) {
      expect(completionEvidencePolicyFromStorage(value)).toEqual(DEFAULT_COMPLETION_EVIDENCE_POLICY);
    }
  });

  it("rejects unknown keys rather than storing them", () => {
    expect(
      completionEvidencePolicyFromStorage({
        enabled: true,
        scope: "all",
        require: "either",
        countDescendants: true,
        alsoRequireApproval: true,
      }),
    ).toEqual(DEFAULT_COMPLETION_EVIDENCE_POLICY);
  });
});
