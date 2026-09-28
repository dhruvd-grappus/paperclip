import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Providers panel for Grappus fork builds (sidebar build dialog).
 *
 * Shows which Claude versions this host runs and what npm has, and queues the
 * two host actions the panel offers. Like self-update, the server never gets
 * root: it writes `request.json` into the providers directory and the root
 * path unit on the host (paperclip-providers.path → `paperclip-providers
 * apply-request`) applies it and reports back in `status.json`.
 *
 * - Agent runtime: the Claude Agent SDK (and the Claude Code build it bundles)
 *   plus the ACP bridge that agent runs use. Pinned by the vendored runner's
 *   qualified profile, so it is shown, never updated from here.
 * - Host CLI: the `claude` on PATH (login, token refresh, account swaps).
 * - Effort: Claude Code's effort for every agent run, from the host's
 *   managed-settings drop-in (the only place that reaches runs in any working
 *   directory; the runner passes no other settings or env through).
 */

export const EFFORT_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

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

export interface InstanceProvidersInfo {
  agentRuntime: {
    sdk: ProviderVersion;
    claudeCode: ProviderVersion;
    acpBridge: ProviderVersion;
    pinned: true;
  };
  hostCli: ProviderVersion;
  effort: { level: EffortLevel; levels: readonly EffortLevel[] };
  status: ProvidersActionStatus | null;
}

export class InstanceProvidersError extends Error {
  constructor(readonly code: "providers_invalid_action" | "providers_in_progress", message: string) {
    super(message);
    this.name = "InstanceProvidersError";
  }
}

const EFFORT_DROPIN = "/etc/claude-code/managed-settings.d/50-paperclip-effort.json";
const LATEST_CACHE_MS = 10 * 60 * 1000;
const CLI_CACHE_MS = 60 * 1000;
const STALE_IN_FLIGHT_MS = 30 * 60 * 1000;

export function defaultProvidersDir(): string {
  return process.env.PAPERCLIP_GRAPPUS_PROVIDERS_DIR ?? join(homedir(), ".paperclip", "grappus-providers");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Nearest node_modules (walking up from this file) that holds the package. */
export function findPackageJson(pkg: string, from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", pkg, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseEffort(raw: Record<string, unknown> | null): EffortLevel {
  const value = raw?.effortLevel;
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as EffortLevel)
    : "default";
}

export function instanceProvidersService(opts: {
  dir?: string;
  effortDropin?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  packageJson?: (pkg: string) => string | null;
  hostCliVersion?: () => Promise<string | null>;
} = {}) {
  const dir = opts.dir ?? defaultProvidersDir();
  const effortDropin = opts.effortDropin ?? EFFORT_DROPIN;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const packageJson = opts.packageJson ?? ((pkg: string) => findPackageJson(pkg));
  const latestCache = new Map<string, { at: number; version: string | null }>();
  let cliCache: { at: number; version: string | null } | null = null;

  const installed = (pkg: string, field = "version"): string | null => {
    const path = packageJson(pkg);
    const value = path ? readJson(path)?.[field] : null;
    return typeof value === "string" ? value : null;
  };

  async function latest(pkg: string, force: boolean): Promise<string | null> {
    const hit = latestCache.get(pkg);
    if (!force && hit && now() - hit.at < LATEST_CACHE_MS) return hit.version;
    let version: string | null = null;
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${pkg}/latest`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { version?: unknown };
        version = typeof body.version === "string" ? body.version : null;
      }
    } catch {
      version = hit?.version ?? null;
    }
    latestCache.set(pkg, { at: now(), version });
    return version;
  }

  const hostCliVersion =
    opts.hostCliVersion ??
    (() =>
      new Promise<string | null>((resolve) => {
        execFile("claude", ["--version"], { timeout: 10_000 }, (err, stdout) => {
          resolve(err ? null : (stdout.trim().split(/\s+/)[0] ?? null) || null);
        });
      }));

  async function cliVersion(force: boolean): Promise<string | null> {
    if (!force && cliCache && now() - cliCache.at < CLI_CACHE_MS) return cliCache.version;
    cliCache = { at: now(), version: await hostCliVersion() };
    return cliCache.version;
  }

  function status(): ProvidersActionStatus | null {
    const raw = readJson(join(dir, "status.json"));
    if (!raw) return null;
    const state = raw.state as ProvidersActionState;
    if (!["queued", "running", "succeeded", "failed"].includes(state)) return null;
    return {
      state,
      action: typeof raw.action === "string" ? raw.action : null,
      message: typeof raw.message === "string" ? raw.message : null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  }

  function inFlight(current: ProvidersActionStatus | null): boolean {
    if (!current || (current.state !== "queued" && current.state !== "running")) return false;
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

  async function info(force = false): Promise<InstanceProvidersInfo> {
    const [sdkLatest, cliLatest, acpLatest, hostCli] = await Promise.all([
      latest("@anthropic-ai/claude-agent-sdk", force),
      latest("@anthropic-ai/claude-code", force),
      latest("@agentclientprotocol/claude-agent-acp", force),
      cliVersion(force),
    ]);
    return {
      agentRuntime: {
        sdk: { installed: installed("@anthropic-ai/claude-agent-sdk"), latest: sdkLatest },
        claudeCode: { installed: installed("@anthropic-ai/claude-agent-sdk", "claudeCodeVersion"), latest: cliLatest },
        acpBridge: { installed: installed("@agentclientprotocol/claude-agent-acp"), latest: acpLatest },
        pinned: true,
      },
      hostCli: { installed: hostCli, latest: cliLatest },
      effort: { level: parseEffort(readJson(effortDropin)), levels: EFFORT_LEVELS },
      status: status(),
    };
  }

  /** Queue one host action. Only these two exist; the root helper re-validates. */
  function request(
    body: { action?: unknown; effortLevel?: unknown },
    requestedBy: string,
  ): ProvidersActionStatus {
    const action = body.action;
    if (action !== "set_effort" && action !== "update_claude_cli") {
      throw new InstanceProvidersError("providers_invalid_action", "Unknown action.");
    }
    if (action === "set_effort" && !(EFFORT_LEVELS as readonly unknown[]).includes(body.effortLevel)) {
      throw new InstanceProvidersError("providers_invalid_action", "Unknown effort level.");
    }
    if (inFlight(status())) {
      throw new InstanceProvidersError("providers_in_progress", "Another provider action is still running.");
    }
    const at = new Date(now()).toISOString();
    const queued: ProvidersActionStatus = { state: "queued", action, message: "Waiting for the host.", updatedAt: at };
    writeAtomic("status.json", queued);
    cliCache = null;
    // The request file is what the host's path unit watches; write it last.
    writeAtomic("request.json", {
      action,
      ...(action === "set_effort" ? { effortLevel: body.effortLevel } : {}),
      requestedBy,
      requestedAt: at,
    });
    return queued;
  }

  return { info, status, request };
}

export type InstanceProvidersService = ReturnType<typeof instanceProvidersService>;
