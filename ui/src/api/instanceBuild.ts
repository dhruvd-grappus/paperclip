import { api } from "./client";

export interface InstanceBuildCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  committedAt: string;
}

/** Mirrors server/src/services/instance-build.ts. */
export interface InstanceBuildInfo {
  commit: string | null;
  shortCommit: string | null;
  base: string | null;
  build: string | null;
  branch: string | null;
  builtAt: string | null;
  repositoryUrl: string | null;
  commits: InstanceBuildCommit[];
}

export const instanceBuildApi = {
  get: () => api.get<InstanceBuildInfo>("/instance/build"),
};

export interface InstanceUpdateRelease {
  tag: string;
  sha: string;
  build: string | null;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string | null;
}

export type InstanceUpdateState = "queued" | "waiting_idle" | "installing" | "succeeded" | "failed" | "rolled_back";

export interface InstanceUpdateStatus {
  state: InstanceUpdateState;
  tag: string | null;
  message: string | null;
  updatedAt: string | null;
}

/** Mirrors InstanceAutoUpdateInfo in server/src/services/instance-update.ts. */
export interface InstanceAutoUpdateInfo {
  enabled: boolean;
  active: boolean;
  intervalMs: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastQueuedTag: string | null;
  lastQueuedAt: string | null;
  lastSkipReason: string | null;
}

/** Mirrors GET /instance/build/update (server/src/routes/instance-settings.ts). */
export interface InstanceUpdateInfo {
  enabled: boolean;
  canUpdate: boolean;
  latest: InstanceUpdateRelease | null;
  updateAvailable: boolean;
  status: InstanceUpdateStatus | null;
  /** Automatic-update poller state; null on builds that predate it. */
  auto?: InstanceAutoUpdateInfo | null;
  error: string | null;
}

export const instanceUpdateApi = {
  get: (refresh = false) => api.get<InstanceUpdateInfo>(`/instance/build/update${refresh ? "?refresh=1" : ""}`),
  request: (tag: string) => api.post<InstanceUpdateStatus>("/instance/build/update", { tag }),
};
