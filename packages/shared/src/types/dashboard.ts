export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  /**
   * True failures for the day, excluding process-loss/restart kills that were
   * later recovered by a successful retry (those are surfaced in `recovered`).
   */
  failed: number;
  /**
   * Runs that terminated in a failure state (failed/timed_out) but whose retry
   * chain eventually succeeded — e.g. restart-killed runs that recovered. Kept
   * out of `failed` so the headline failure count reflects true, unrecovered
   * failures.
   */
  recovered: number;
  other: number;
  total: number;
  /**
   * Per-error-code breakdown of the (true) `failed` count for the day, so a
   * spike can be attributed to an error class (e.g. `process_lost`,
   * `provider_quota`, `workspace_validation_failed`). Recovered runs are not
   * included here. Runs with no error code are bucketed under `unknown`.
   */
  failedByErrorCode: Record<string, number>;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  /**
   * Work a person signed off on, so the dashboard can show what human review
   * has actually cleared rather than only what is still queued. Only decisions
   * carrying a user id count — an agent resolving its own confirmation is not
   * human approval.
   */
  humanApproved: {
    /**
     * Tasks in the `human_approved` status — the status that records a person
     * signed the work off. Not "tasks with an accepted confirmation": a person
     * can approve a plan on a task that then keeps running, so that population
     * is larger and does not match the list the dashboard card links to.
     */
    tasks: number;
    /** Confirmation interactions a person accepted, across all tasks. */
    confirmations: number;
    /** Approval-queue requests a person approved. */
    approvals: number;
  };
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}
