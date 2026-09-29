import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Self-update for Grappus fork builds.
 *
 * CI (fork workflow "grappus overlay") publishes every grappus/stable build as
 * a GitHub release `overlay-<sha12>`. This service reads the latest release and
 * queues an update by writing `request.json` into the update directory, either
 * on "Update now" or from the auto-updater below (instanceAutoUpdater). It
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

/**
 * Automatic updates: poll GitHub for the latest CI release and queue it the same
 * way "Update now" does. Everything that makes an update safe stays on the host
 * side (paperclip-overlay apply-request waits until no agent run is live,
 * verifies the new install and rolls back on failure); this only removes the
 * click. Guards:
 *
 *  - never queues while a request is in flight;
 *  - a build that failed verification and was rolled back is never retried
 *    automatically (it is a bad build; a human can still force it from the UI);
 *  - a build whose install failed for another reason (host never went idle,
 *    download error) is retried after FAILED_RETRY_MS;
 *  - the `requestedBy` marker is "auto-update", so the UI can tell the two apart;
 *  - opt out with PAPERCLIP_GRAPPUS_AUTO_UPDATE=0 (restart) or by creating
 *    `<update dir>/auto-update.disabled` (no restart needed).
 */
export const AUTO_UPDATE_REQUESTED_BY = "auto-update";
export const AUTO_UPDATE_DISABLE_FILE = "auto-update.disabled";
const AUTO_UPDATE_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_UPDATE_MIN_INTERVAL_MS = 60 * 1000;
const AUTO_UPDATE_INITIAL_DELAY_MS = 60 * 1000;
const FAILED_RETRY_MS = 60 * 60 * 1000;

export interface InstanceAutoUpdateInfo {
  /** Configured on at boot (env). */
  enabled: boolean;
  /** Enabled and not paused by the disable file. */
  active: boolean;
  intervalMs: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastQueuedTag: string | null;
  lastQueuedAt: string | null;
  /** Why the last tick did nothing, for the settings page. */
  lastSkipReason: string | null;
}

export function autoUpdateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PAPERCLIP_GRAPPUS_AUTO_UPDATE ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

export function autoUpdateIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAPERCLIP_GRAPPUS_AUTO_UPDATE_INTERVAL_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return AUTO_UPDATE_DEFAULT_INTERVAL_MS;
  return Math.max(AUTO_UPDATE_MIN_INTERVAL_MS, Math.floor(raw));
}

export function instanceAutoUpdater(opts: {
  updates: InstanceUpdateService;
  /** The commit this server runs; a release whose sha prefixes it is already installed. */
  currentCommit: string | null;
  dir?: string;
  enabled?: boolean;
  intervalMs?: number;
  now?: () => number;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}) {
  const dir = opts.dir ?? defaultInstanceUpdateDir();
  const now = opts.now ?? Date.now;
  const enabled = opts.enabled ?? autoUpdateEnabledFromEnv();
  const intervalMs = opts.intervalMs ?? autoUpdateIntervalFromEnv();
  const log = opts.log ?? { info: () => {}, warn: () => {} };
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  const state: InstanceAutoUpdateInfo = {
    enabled,
    active: enabled,
    intervalMs,
    lastCheckedAt: null,
    lastError: null,
    lastQueuedTag: null,
    lastQueuedAt: null,
    lastSkipReason: null,
  };

  function paused(): boolean {
    return existsSync(join(dir, AUTO_UPDATE_DISABLE_FILE));
  }

  function skip(reason: string) {
    state.lastSkipReason = reason;
    return { queued: false as const, reason };
  }

  /** One poll. Returns what happened so tests and the status endpoint can see it. */
  async function tick(): Promise<{ queued: boolean; reason: string }> {
    if (ticking) return skip("previous check still running");
    ticking = true;
    try {
      state.active = enabled && !paused();
      if (!enabled) return skip("disabled by PAPERCLIP_GRAPPUS_AUTO_UPDATE");
      if (!state.active) return skip(`paused by ${AUTO_UPDATE_DISABLE_FILE}`);
      state.lastCheckedAt = new Date(now()).toISOString();
      let latest: InstanceUpdateRelease | null;
      try {
        latest = await opts.updates.latestRelease(true);
        state.lastError = null;
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        return skip(`GitHub check failed: ${state.lastError}`);
      }
      if (!latest) return skip("no release published");
      if (opts.currentCommit && opts.currentCommit.startsWith(latest.sha)) return skip("already on the latest build");
      const status = opts.updates.status();
      if (opts.updates.inFlight()) return skip(`update ${status?.tag ?? ""} in flight`.trim());
      if (status?.tag === latest.tag) {
        if (status.state === "rolled_back") return skip(`${latest.tag} failed verification and was rolled back; not retrying automatically`);
        if (status.state === "succeeded") return skip(`${latest.tag} already installed`);
        if (status.state === "failed") {
          const at = status.updatedAt ? Date.parse(status.updatedAt) : Number.NaN;
          if (Number.isFinite(at) && now() - at < FAILED_RETRY_MS) {
            return skip(`${latest.tag} failed ${Math.round((now() - at) / 60000)} min ago; retrying after ${FAILED_RETRY_MS / 60000} min`);
          }
        }
      }
      try {
        await opts.updates.request(latest.tag, AUTO_UPDATE_REQUESTED_BY);
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        return skip(`could not queue ${latest.tag}: ${state.lastError}`);
      }
      state.lastQueuedTag = latest.tag;
      state.lastQueuedAt = new Date(now()).toISOString();
      state.lastSkipReason = null;
      log.info({ tag: latest.tag, build: latest.build }, "auto-update: queued latest build");
      return { queued: true, reason: `queued ${latest.tag}` };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer || !enabled) return;
    const run = () => {
      void tick()
        .then((result) => {
          if (!result.queued) log.info({ reason: result.reason }, "auto-update: nothing to do");
        })
        .catch((err) => log.warn({ err }, "auto-update: check failed"));
    };
    // Give the host time to finish booting (and the previous install's status to settle).
    timer = setTimeout(() => {
      run();
      timer = setInterval(run, intervalMs);
      timer.unref();
    }, AUTO_UPDATE_INITIAL_DELAY_MS);
    timer.unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    if (timer) clearInterval(timer);
    timer = null;
  }

  function info(): InstanceAutoUpdateInfo {
    return { ...state, active: enabled && !paused() };
  }

  return { tick, start, stop, info };
}

export type InstanceAutoUpdater = ReturnType<typeof instanceAutoUpdater>;
