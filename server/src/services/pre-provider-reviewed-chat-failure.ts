import { and, eq, sql } from "drizzle-orm";
import {
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeRunFinalizations,
  nativeRunResults,
  type Db,
} from "@paperclipai/db";
import { readChatControlRecoveryAdmission } from "./chat-control-recovery-stop.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOnlyPreProviderDispatchMetadata(
  run: typeof heartbeatRuns.$inferSelect,
  requireDispatchMetadata: boolean,
): boolean {
  if (run.runnerProfileJson === null) return !requireDispatchMetadata;
  const profile = record(run.runnerProfileJson);
  const dispatch = record(profile.adapterDispatch);
  const recovery = record(record(run.resultJson).executionRecovery);
  return (
    Object.keys(profile).length === 3 &&
    Object.hasOwn(profile, "adapterDispatch") &&
    Object.hasOwn(profile, "chatControlRecoveryAdmission") &&
    profile.aiConnectionNonAssigneeCommentWake === false &&
    Object.keys(dispatch).length === 1 &&
    typeof dispatch.adapterType === "string" &&
    readChatControlRecoveryAdmission(run) === "required" &&
    recovery.kind === "bootstrap" &&
    recovery.providerWorkStarted === false
  );
}

export const PRE_PROVIDER_REVIEWED_CHAT_FAILURE =
  "reviewed_chat_execution_binding_not_authorized";
export const PRE_PROVIDER_REVIEWED_CHAT_RETRY_MARKER_PREFIX =
  "pre-provider-reviewed-chat-retry:";

/** Exact proof that reviewed-chat authorization failed before provider work. */
export async function isPreProviderReviewedChatFailure(
  tx: DbOrTransaction,
  run: typeof heartbeatRuns.$inferSelect,
  options: { requireDispatchMetadata?: boolean } = {},
): Promise<boolean> {
  const diagnostic = PRE_PROVIDER_REVIEWED_CHAT_FAILURE;
  if (
    run.runtimeMode !== "legacy" ||
    run.errorCode !== "setup_failed" ||
    run.error !== diagnostic ||
    [
      run.runtimeModeResolverVersion,
      run.runtimeModeReason,
      run.runtimeModeResolvedAt,
      run.runnerInstanceId,
      run.nativeSessionId,
      run.nativeIssueId,
      run.nativePhase,
      run.driverKind,
      run.driverVersion,
      run.completionContractId,
      run.completionContractSha256,
      run.sessionIdAfter,
      run.externalRunId,
      run.processPid,
      run.processGroupId,
      run.processStartedAt,
      run.logStore,
      run.logRef,
      run.logBytes,
      run.logSha256,
      run.stdoutExcerpt,
      run.stderrExcerpt,
      run.lastOutputAt,
      run.lastOutputStream,
      run.lastOutputBytes,
      run.usageJson,
      run.exitCode,
      run.signal,
    ].some((value) => value !== null) ||
    run.lastOutputSeq !== 0 ||
    run.logCompressed ||
    !hasOnlyPreProviderDispatchMetadata(
      run,
      options.requireDispatchMetadata === true,
    )
  )
    return false;
  const events = await tx
    .select()
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.companyId, run.companyId),
        eq(heartbeatRunEvents.runId, run.id),
      ),
    )
    .limit(2)
    .for("share", { noWait: true });
  const event = events[0];
  if (
    events.length !== 1 ||
    !event ||
    event.agentId !== run.agentId ||
    event.seq !== 1 ||
    event.eventType !== "error" ||
    event.stream !== "system" ||
    event.level !== "error" ||
    event.message !== diagnostic ||
    event.payload !== null ||
    event.sourceInstanceId !== null ||
    event.sourceEventId !== null ||
    event.sourceSeq !== null ||
    event.sourcePayloadSha256 !== null ||
    event.protocolSchemaVersion !== null
  )
    return false;
  const evidence = await tx.execute(sql`select 1 where
      exists (select 1 from ${nativeRunFinalizations} where company_id = ${run.companyId}::uuid and run_id = ${run.id}::uuid)
      or exists (select 1 from ${nativeRunResults} where company_id = ${run.companyId}::uuid and run_id = ${run.id}::uuid)
      or exists (select 1 from ${environmentLeases} where company_id = ${run.companyId}::uuid and heartbeat_run_id = ${run.id}::uuid)`);
  return evidence.length === 0;
}
