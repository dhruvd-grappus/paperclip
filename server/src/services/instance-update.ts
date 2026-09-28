import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Self-update for Grappus fork builds.
 *
 * CI (fork workflow "grappus overlay") publishes every grappus/stable build as
 * a GitHub release `overlay-<sha12>`. This service reads the latest release and
 * queues an update by writing `request.json` into the update directory. It
 * never installs anything itself: a root systemd path unit on the host
 * (paperclip-update.path → `paperclip-overlay apply-request`) picks the request
 * up, waits for agent runs to finish, installs the release, restarts Paperclip
 * and reports progress in `status.json`, which this service reads back.
 */

export const UPDATE_TAG_PATTERN = /^overlay-([0-9a-f]{12})$/;

export interface InstanceUpdateRelease {
  tag: string;
  sha: string;
  build: string | null;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string | null;
}

export type InstanceUpdateState =
  | "queued"
  | "waiting_idle"
  | "installing"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface InstanceUpdateStatus {
  state: InstanceUpdateState;
  tag: string | null;
  message: string | null;
  updatedAt: string | null;
}

/** An in-flight update older than this is treated as abandoned. */
const STALE_IN_FLIGHT_MS = 2 * 60 * 60 * 1000;
const RELEASE_CACHE_MS = 60 * 1000;
const IN_FLIGHT: ReadonlySet<InstanceUpdateState> = new Set(["queued", "waiting_idle", "installing"]);

export class InstanceUpdateError extends Error {
  constructor(
    readonly code: "update_not_latest" | "update_in_progress" | "update_invalid_tag" | "update_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "InstanceUpdateError";
  }
}

export function defaultInstanceUpdateDir(): string {
  return process.env.PAPERCLIP_GRAPPUS_UPDATE_DIR ?? join(homedir(), ".paperclip", "grappus-updates");
}

/** "https://github.com/owner/repo" → "owner/repo". */
export function githubRepoSlug(repositoryUrl: string | null): string | null {
  const match = repositoryUrl?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

export function parseRelease(raw: unknown): InstanceUpdateRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const tag = typeof row.tag_name === "string" ? row.tag_name : "";
  const match = tag.match(UPDATE_TAG_PATTERN);
  if (!match) return null;
  const assets = Array.isArray(row.assets) ? row.assets : [];
  const hasTarball = assets.some(
    (asset) => asset && typeof asset === "object" && (asset as { name?: unknown }).name === "paperclip-overlay.tgz",
  );
  if (!hasTarball || row.draft === true || row.prerelease === true) return null;
  const name = typeof row.name === "string" && row.name ? row.name : tag;
  return {
    tag,
    sha: match[1],
    build: name.match(/grappus\.(\d+)/)?.[1] ?? null,
    name,
    notes: typeof row.body === "string" ? row.body : "",
    publishedAt: typeof row.published_at === "string" ? row.published_at : null,
    url: typeof row.html_url === "string" ? row.html_url : null,
  };
}

/** Token for authenticated release checks (5000/hr vs 60/hr anonymous). */
export function instanceUpdateGitHubToken(opts: { token?: string }): string | null {
  return (
    opts.token ??
    process.env.PAPERCLIP_GRAPPUS_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    null
  );
}

/** Friendly message for GitHub failures; names the rate-limit reset when known. */
async function githubErrorMessage(response: Response): Promise<string> {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAfter = response.headers.get("retry-after");
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const rateLimited =
    response.status === 429 || remaining === "0" || /rate limit/i.test(body);
  if (rateLimited) {
    const resetAt = reset ? new Date(Number(reset) * 1000) : null;
    if (resetAt && !Number.isNaN(resetAt.getTime())) {
      return `GitHub rate limit exceeded, retry after ${resetAt.toISOString().slice(11, 16)} UTC`;
    }
    if (retryAfter) return `GitHub rate limit exceeded, retry in ${retryAfter}s`;
    return "GitHub rate limit exceeded, try again later";
  }
  return `GitHub answered ${response.status}`;
}

export function instanceUpdateService(opts: {
  repo: string;
  dir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  token?: string;
}) {
  const dir = opts.dir ?? defaultInstanceUpdateDir();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const token = instanceUpdateGitHubToken(opts);
  let cache: { at: number; release: InstanceUpdateRelease | null } | null = null;

  async function latestRelease(force = false): Promise<InstanceUpdateRelease | null> {
    if (!force && cache && now() - cache.at < RELEASE_CACHE_MS) return cache.release;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "paperclip-grappus-updater",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`https://api.github.com/repos/${opts.repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      cache = { at: now(), release: null };
      return null;
    }
    if (!response.ok) {
      throw new InstanceUpdateError("update_unavailable", await githubErrorMessage(response));
    }
    const release = parseRelease(await response.json());
    cache = { at: now(), release };
    return release;
  }

  /** Last-known release (even past the cache window); served when GitHub fails. */
  function cached(): InstanceUpdateRelease | null {
    return cache?.release ?? null;
  }

  function status(): InstanceUpdateStatus | null {
    try {
      const raw = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as Record<string, unknown>;
      const state = raw.state as InstanceUpdateState;
      if (!["queued", "waiting_idle", "installing", "succeeded", "failed", "rolled_back"].includes(state)) return null;
      return {
        state,
        tag: typeof raw.tag === "string" ? raw.tag : null,
        message: typeof raw.message === "string" ? raw.message : null,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
      };
    } catch {
      return null;
    }
  }

  function inFlight(current: InstanceUpdateStatus | null): boolean {
    if (!current || !IN_FLIGHT.has(current.state)) return false;
    const at = current.updatedAt ? Date.parse(current.updatedAt) : Number.NaN;
    return Number.isFinite(at) && now() - at < STALE_IN_FLIGHT_MS;
  }

  function writeAtomic(name: string, value: unknown) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, name);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  }

  /** Queue the latest release. Only the latest CI build can be requested. */
  async function request(tag: string, requestedBy: string): Promise<InstanceUpdateStatus> {
    if (!UPDATE_TAG_PATTERN.test(tag)) {
      throw new InstanceUpdateError("update_invalid_tag", "Unknown build.");
    }
    const latest = await latestRelease(true);
    if (!latest || latest.tag !== tag) {
      throw new InstanceUpdateError("update_not_latest", "Only the latest build can be installed.");
    }
    if (inFlight(status())) {
      throw new InstanceUpdateError("update_in_progress", "An update is already in progress.");
    }
    const at = new Date(now()).toISOString();
    const queued: InstanceUpdateStatus = {
      state: "queued",
      tag,
      message: "Waiting for the host updater.",
      updatedAt: at,
    };
    writeAtomic("status.json", queued);
    // The request file is what the host's path unit watches; write it last.
    writeAtomic("request.json", { tag, requestedBy, requestedAt: at });
    return queued;
  }

  return { latestRelease, cached, status, request, inFlight: () => inFlight(status()) };
}

export type InstanceUpdateService = ReturnType<typeof instanceUpdateService>;
