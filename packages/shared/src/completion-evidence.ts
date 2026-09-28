import type { IssueWorkProduct } from "./types/work-product.js";

/**
 * Work product types that count as proof a task actually produced something.
 *
 * `pull_request` is the code path. The rest are the "artifact or testing link"
 * path: an uploaded file (screenshot, report, export), a published preview, or
 * a running service someone can open. A `branch` or a `commit` deliberately
 * does not count — pushing a branch is not evidence that the work was checked,
 * which is the whole point of asking for evidence.
 */
export const COMPLETION_EVIDENCE_WORK_PRODUCT_TYPES = [
  "pull_request",
  "artifact",
  "preview_url",
  "runtime_service",
] as const;

export type CompletionEvidenceWorkProductType =
  (typeof COMPLETION_EVIDENCE_WORK_PRODUCT_TYPES)[number];

const EVIDENCE_TYPE_SET: ReadonlySet<string> = new Set(COMPLETION_EVIDENCE_WORK_PRODUCT_TYPES);

/**
 * Work product statuses that no longer stand behind the work. A closed PR or a
 * failed preview is a record that something was attempted, not evidence that it
 * landed, so neither satisfies the gate.
 */
const RETRACTED_WORK_PRODUCT_STATUSES: ReadonlySet<string> = new Set([
  "closed",
  "failed",
  "archived",
]);

type WorkProductLike = Pick<IssueWorkProduct, "type"> & {
  url?: string | null;
  status?: string | null;
};

/** A single work product that can stand as completion evidence. */
export function isCompletionEvidence(workProduct: WorkProductLike): boolean {
  if (!EVIDENCE_TYPE_SET.has(workProduct.type)) return false;
  if (workProduct.status != null && RETRACTED_WORK_PRODUCT_STATUSES.has(workProduct.status)) {
    return false;
  }
  // An evidence row with no link is not something a reviewer can open, so it
  // proves nothing. `artifact` is exempt: an uploaded attachment carries its
  // location in `metadata` and legitimately has no `url`.
  if (workProduct.type !== "artifact" && !workProduct.url) return false;
  return true;
}

export interface CompletionEvidenceResult {
  satisfied: boolean;
  /** Evidence types actually present, for a message that says what is missing. */
  presentTypes: string[];
}

/**
 * Whether a task carries enough evidence to be completed: at least one
 * pull request, artifact, preview, or running service.
 *
 * One is enough, not one of each. Plenty of real work produces exactly one kind
 * — a docs change has a PR and nothing to screenshot; a research task has a
 * report and no PR — and demanding both would make those tasks uncompletable.
 */
export function evaluateCompletionEvidence(
  workProducts: readonly WorkProductLike[],
): CompletionEvidenceResult {
  const presentTypes = [
    ...new Set(workProducts.filter(isCompletionEvidence).map((product) => product.type)),
  ];
  return { satisfied: presentTypes.length > 0, presentTypes };
}

/** Convenience wrapper around {@link evaluateCompletionEvidence}. */
export function hasCompletionEvidence(workProducts: readonly WorkProductLike[]): boolean {
  return evaluateCompletionEvidence(workProducts).satisfied;
}

// ---------------------------------------------------------------------------
// Completion gate policy
// ---------------------------------------------------------------------------

/** Which tasks the gate applies to. */
export type CompletionEvidenceScope = "all" | "parents" | "roots";

/** How much evidence a task in scope has to show. */
export type CompletionEvidenceRequirement = "either" | "both";

/**
 * When a task may move to `done`.
 *
 * This is deliberately configuration rather than a hardcoded predicate. The
 * requirement moved five times while it was being specified — every tightening
 * and loosening was reasonable, and none of them should cost a deploy. Holding
 * it as data means changing the rule is a settings edit.
 *
 * It ships disabled. Measured against this company's own history, no task had
 * ever recorded a `pull_request` work product, so switching any PR-requiring
 * variant on at merge time would have blocked every completion at once. Turn it
 * on once agents reliably emit work products, not before.
 */
export interface CompletionEvidencePolicy {
  enabled: boolean;
  scope: CompletionEvidenceScope;
  require: CompletionEvidenceRequirement;
  /**
   * Credit a parent with evidence recorded on its descendants. An umbrella task
   * correctly has no pull request of its own — its children did the work — so a
   * parent-scoped gate is close to unsatisfiable without this.
   */
  countDescendants: boolean;
}

export const DEFAULT_COMPLETION_EVIDENCE_POLICY: CompletionEvidencePolicy = {
  enabled: false,
  scope: "all",
  require: "either",
  countDescendants: true,
};

export interface CompletionGateSubject {
  /** The task has at least one child. */
  hasChildren: boolean;
  /** The task has no parent. */
  isRoot: boolean;
  ownWorkProducts: readonly WorkProductLike[];
  /** Work products on descendants; ignored unless `countDescendants` is set. */
  descendantWorkProducts?: readonly WorkProductLike[];
}

export type CompletionGateFailureReason = "missing_pull_request" | "missing_artifact" | "missing_any";

export interface CompletionGateResult {
  allowed: boolean;
  /** False when the policy simply does not cover this task. */
  inScope: boolean;
  reason: CompletionGateFailureReason | null;
  presentTypes: string[];
}

function isInScope(policy: CompletionEvidencePolicy, subject: CompletionGateSubject): boolean {
  if (policy.scope === "all") return true;
  if (policy.scope === "parents") return subject.hasChildren;
  return subject.isRoot;
}

/** Whether a task may move to `done` under the given policy. */
export function evaluateCompletionGate(
  policy: CompletionEvidencePolicy,
  subject: CompletionGateSubject,
): CompletionGateResult {
  if (!policy.enabled || !isInScope(policy, subject)) {
    return { allowed: true, inScope: false, reason: null, presentTypes: [] };
  }

  const considered = policy.countDescendants
    ? [...subject.ownWorkProducts, ...(subject.descendantWorkProducts ?? [])]
    : subject.ownWorkProducts;
  const { presentTypes } = evaluateCompletionEvidence(considered);

  const hasPullRequest = presentTypes.includes("pull_request");
  const hasArtifact = presentTypes.some((type) => type !== "pull_request");

  if (policy.require === "both") {
    if (hasPullRequest && hasArtifact) {
      return { allowed: true, inScope: true, reason: null, presentTypes };
    }
    return {
      allowed: false,
      inScope: true,
      reason: hasPullRequest ? "missing_artifact" : "missing_pull_request",
      presentTypes,
    };
  }

  const allowed = hasPullRequest || hasArtifact;
  return {
    allowed,
    inScope: true,
    reason: allowed ? null : "missing_any",
    presentTypes,
  };
}
