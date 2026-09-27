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
