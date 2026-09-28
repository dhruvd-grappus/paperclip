import { api } from "./client";

export type EffortLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max";
export type ProvidersActionState = "queued" | "running" | "succeeded" | "failed";

export interface ProvidersActionStatus {
  state: ProvidersActionState;
  action: string | null;
  message: string | null;
  updatedAt: string | null;
}

export interface ProviderVersion {
  installed: string | null;
  latest: string | null;
}

/** Mirrors GET /instance/providers (server/src/services/instance-providers.ts). */
export interface InstanceProvidersInfo {
  enabled: boolean;
  canManage: boolean;
  agentRuntime?: { sdk: ProviderVersion; claudeCode: ProviderVersion; acpBridge: ProviderVersion; pinned: true };
  hostCli?: ProviderVersion;
  effort?: { level: EffortLevel; levels: EffortLevel[] };
  status?: ProvidersActionStatus | null;
}

export type ProvidersAction =
  | { action: "set_effort"; effortLevel: EffortLevel }
  | { action: "update_claude_cli" };

export const instanceProvidersApi = {
  get: (refresh = false) => api.get<InstanceProvidersInfo>(`/instance/providers${refresh ? "?refresh=1" : ""}`),
  act: (body: ProvidersAction) => api.post<ProvidersActionStatus>("/instance/providers/action", body),
};
