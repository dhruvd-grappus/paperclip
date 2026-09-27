import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What this server was built from, for the sidebar build badge.
 *
 * Fork builds (scripts/write-grappus-build.mjs) write dist/grappus-build.json
 * with the running commit, the upstream base it sits on, and every commit
 * since that base, which doubles as the changelog. Upstream builds only carry
 * dist/build-info.json ({ commit }), so the badge still shows a commit there.
 */
export interface InstanceBuildCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  committedAt: string;
}

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

const EMPTY: InstanceBuildInfo = {
  commit: null,
  shortCommit: null,
  base: null,
  build: null,
  branch: null,
  builtAt: null,
  repositoryUrl: null,
  commits: [],
};

function readJson(url: URL): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function commitsFrom(value: unknown): InstanceBuildCommit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const sha = str(row.sha);
    const subject = str(row.subject);
    if (!sha || !subject) return [];
    return [{
      sha,
      shortSha: str(row.shortSha) ?? sha.slice(0, 9),
      subject,
      body: typeof row.body === "string" ? row.body : "",
      author: str(row.author) ?? "",
      committedAt: str(row.committedAt) ?? "",
    }];
  });
}

export function readInstanceBuildInfo(
  distDir: URL = new URL("../", import.meta.url),
): InstanceBuildInfo {
  const fork = readJson(new URL("grappus-build.json", distDir));
  if (fork) {
    const commit = str(fork.commit);
    return {
      commit,
      shortCommit: str(fork.shortCommit) ?? commit?.slice(0, 9) ?? null,
      base: str(fork.base),
      build: str(fork.build),
      branch: str(fork.branch),
      builtAt: str(fork.builtAt),
      repositoryUrl: str(fork.repositoryUrl),
      commits: commitsFrom(fork.commits),
    };
  }
  const upstream = readJson(new URL("build-info.json", distDir));
  const commit = str(upstream?.commit);
  return commit ? { ...EMPTY, commit, shortCommit: commit.slice(0, 9) } : EMPTY;
}

let cached: InstanceBuildInfo | null = null;

/** The build files never change while the process runs. */
export function instanceBuildInfo(): InstanceBuildInfo {
  cached ??= readInstanceBuildInfo();
  return cached;
}
