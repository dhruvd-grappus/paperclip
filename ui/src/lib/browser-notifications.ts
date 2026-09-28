import type { AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import { attentionTaskRef, sourceMeta } from "./attention";
import { getPageVisibility } from "./page-visibility";

/**
 * Browser (OS-level) notifications for Paperclip (GRA-294).
 *
 * The app already has two in-page channels — toasts (`ToastContext`) and the
 * Decisions/attention queue — and neither maps one-to-one onto a desktop
 * notification. Toasts fire for every mutation acknowledgement (~700 call
 * sites), so mirroring them would turn the OS tray into noise. The rule here
 * is narrower and deliberately boring:
 *
 *   1. **Only human-actionable rows.** The source of truth is the attention
 *      feed — rows the server already decided need a person. Nothing else
 *      (agent chatter, run progress, toasts) ever reaches the OS.
 *   2. **Only when the user is away.** A focused tab already shows the badge
 *      and the queue, so a desktop notification adds nothing; see
 *      `shouldNotifyForVisibility`.
 *   3. **Once per item, ever.** Delivery is keyed on `dedupKey` and the
 *      delivered set is persisted, so a poll loop, a remount, or a second tab
 *      cannot re-announce the same decision.
 *   4. **Bounded volume.** Bursts coalesce into one digest and a rolling
 *      window caps how many notifications a session may emit.
 *
 * Categories exist so a user can keep the urgent lane (approvals, failures)
 * while muting the chatty one, rather than facing a single all-or-nothing
 * switch that most people end up turning off.
 */

export type NotificationCategory =
  | "decisions"
  | "failures"
  | "budget"
  | "reviews";

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "decisions",
  "failures",
  "budget",
  "reviews",
];

export interface NotificationCategoryMeta {
  label: string;
  description: string;
}

export const NOTIFICATION_CATEGORY_META: Record<NotificationCategory, NotificationCategoryMeta> = {
  decisions: {
    label: "Decisions waiting on you",
    description: "Approvals, questions, confirmations and join requests an agent cannot resolve alone.",
  },
  failures: {
    label: "Failed runs and agent errors",
    description: "A run stopped with an error, or an agent needs a recovery action.",
  },
  budget: {
    label: "Budget alerts",
    description: "Spend thresholds that stop work until you raise or acknowledge them.",
  },
  reviews: {
    label: "Reviews and blocked work",
    description: "Work parked for your review, or a task blocked on a dependency you own.",
  },
};

const CATEGORY_BY_SOURCE_KIND: Record<AttentionSourceKind, NotificationCategory | null> = {
  approval: "decisions",
  decision: "decisions",
  issue_thread_interaction: "decisions",
  join_request: "decisions",
  recovery_action: "failures",
  failed_run: "failures",
  agent_error_alert: "failures",
  budget_alert: "budget",
  review: "reviews",
  blocker_attention: "reviews",
  // Retired source, kept for read compatibility with persisted rows. It has no
  // decision verbs left, so it never earns an OS notification.
  productivity_review: null,
};

export function categoryForSourceKind(kind: AttentionSourceKind): NotificationCategory | null {
  return CATEGORY_BY_SOURCE_KIND[kind] ?? null;
}

// ---------------------------------------------------------------------------
// Preferences (per browser, localStorage — there is no server-side profile for
// this yet, and permission is a per-browser grant anyway, so co-locating the
// toggles with the grant keeps the two from disagreeing).
// ---------------------------------------------------------------------------

export const NOTIFICATION_PREFS_KEY = "paperclip:notifications:prefs";

export interface NotificationPreferences {
  /** Master switch. Off until the user explicitly enables and grants permission. */
  enabled: boolean;
  categories: Record<NotificationCategory, boolean>;
  /**
   * Suppress while the tab is focused (default on). Turning this off is for
   * multi-monitor setups where the Paperclip window sits on a screen the user
   * is not looking at.
   */
  onlyWhenUnfocused: boolean;
  /** Ignore `low` severity rows (default on) — they are queue fodder, not interrupts. */
  minSeverityHigh: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: false,
  categories: { decisions: true, failures: true, budget: true, reviews: false },
  onlyWhenUnfocused: true,
  minSeverityHigh: false,
};

function coerceCategories(raw: unknown): Record<NotificationCategory, boolean> {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const result = { ...DEFAULT_NOTIFICATION_PREFERENCES.categories };
  for (const category of NOTIFICATION_CATEGORIES) {
    const value = source[category];
    if (typeof value === "boolean") result[category] = value;
  }
  return result;
}

export function loadNotificationPreferences(): NotificationPreferences {
  try {
    const raw = localStorage.getItem(NOTIFICATION_PREFS_KEY);
    if (!raw) return DEFAULT_NOTIFICATION_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<NotificationPreferences>;
    return {
      enabled: parsed.enabled === true,
      categories: coerceCategories(parsed.categories),
      onlyWhenUnfocused: parsed.onlyWhenUnfocused !== false,
      minSeverityHigh: parsed.minSeverityHigh === true,
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }
}

export function saveNotificationPreferences(prefs: NotificationPreferences) {
  try {
    localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore localStorage failures.
  }
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

export type NotificationPermissionState = "unsupported" | "default" | "granted" | "denied";

export function getNotificationPermission(): NotificationPermissionState {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
  const permission = window.Notification.permission;
  if (permission === "granted" || permission === "denied") return permission;
  return "default";
}

/**
 * Must be called from a user gesture — browsers reject (and Chrome permanently
 * denies) permission prompts raised from background work, which is exactly why
 * nothing in the polling path ever calls this.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
  try {
    const result = await window.Notification.requestPermission();
    return result === "granted" || result === "denied" ? result : "default";
  } catch {
    return getNotificationPermission();
  }
}

// ---------------------------------------------------------------------------
// Anti-spam gates
// ---------------------------------------------------------------------------

/** Bursts above this in one poll collapse into a single digest notification. */
export const DIGEST_THRESHOLD = 3;
/** Ceiling on notifications emitted inside `RATE_LIMIT_WINDOW_MS`. */
export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Cap on remembered dedup keys, so the delivered set cannot grow forever. */
const DELIVERED_LIMIT = 500;
export const DELIVERED_KEYS_STORAGE = "paperclip:notifications:delivered";

export function shouldNotifyForVisibility(prefs: NotificationPreferences): boolean {
  if (!prefs.onlyWhenUnfocused) return true;
  return !getPageVisibility().focused;
}

function isEligibleSeverity(item: AttentionItem, prefs: NotificationPreferences): boolean {
  if (!prefs.minSeverityHigh) return item.severity !== "low";
  return item.severity === "high" || item.severity === "critical";
}

/**
 * Rows that may become a notification: the user's categories, above the
 * severity floor, not already snoozed or dismissed away by the user. Snoozed
 * and dismissed rows are explicit "not now" signals — honouring them here is
 * what keeps a dismissed decision from reappearing as an OS popup.
 */
export function selectNotifiableItems(
  items: readonly AttentionItem[],
  prefs: NotificationPreferences,
  now = Date.now(),
): AttentionItem[] {
  return items.filter((item) => {
    const category = categoryForSourceKind(item.sourceKind);
    if (!category || !prefs.categories[category]) return false;
    if (!isEligibleSeverity(item, prefs)) return false;
    if (item.dismissal?.dismissedAt) return false;
    if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now) return false;
    if (item.archivedAt) return false;
    return true;
  });
}

export interface NotificationPayload {
  /** Stable OS-level tag: re-showing the same tag replaces, never stacks. */
  tag: string;
  title: string;
  body: string;
  /** In-app route opened when the notification is clicked. */
  url: string | null;
}

export function buildItemNotification(item: AttentionItem): NotificationPayload {
  const ref = attentionTaskRef(item);
  const subjectTitle = item.subject.title ?? ref?.identifier ?? "Paperclip";
  const source = sourceMeta(item.sourceKind).label;
  const origin = item.originAgentName ? ` · ${item.originAgentName}` : "";
  return {
    tag: `paperclip:attention:${item.dedupKey}`,
    title: `${source}: ${subjectTitle}`,
    body: `${item.whyNow}${origin}`,
    url: item.subject.href ?? item.relatedIssue?.href ?? null,
  };
}

export function buildDigestNotification(items: readonly AttentionItem[]): NotificationPayload {
  const kinds = new Set(items.map((item) => sourceMeta(item.sourceKind).label.toLowerCase()));
  return {
    // One digest tag per batch timestamp would stack; a constant tag means a
    // second burst replaces the first rather than piling up unread popups.
    tag: "paperclip:attention:digest",
    title: `${items.length} decisions need you`,
    body: `Waiting: ${[...kinds].join(", ")}.`,
    url: "/company/decisions",
  };
}

/**
 * Split a batch of newly-eligible rows into what should actually be shown.
 * Small batches notify individually (the title carries enough to act on);
 * anything larger becomes one digest that deep-links to the queue.
 */
export function planNotifications(items: readonly AttentionItem[]): NotificationPayload[] {
  if (items.length === 0) return [];
  if (items.length > DIGEST_THRESHOLD) return [buildDigestNotification(items)];
  return items.map(buildItemNotification);
}

// ---------------------------------------------------------------------------
// Delivery ledger — "once per item, ever", shared across tabs via localStorage.
// ---------------------------------------------------------------------------

export function loadDeliveredKeys(): string[] {
  try {
    const raw = localStorage.getItem(DELIVERED_KEYS_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function saveDeliveredKeys(keys: readonly string[]) {
  try {
    // Newest wins when trimming: an old key falling out can at worst re-notify
    // a decision that has been open for hundreds of newer ones.
    const trimmed = keys.slice(-DELIVERED_LIMIT);
    localStorage.setItem(DELIVERED_KEYS_STORAGE, JSON.stringify(trimmed));
  } catch {
    // Ignore localStorage failures.
  }
}

/** Rolling-window limiter. Returns how many of `requested` may be emitted now. */
export function rateLimitAllowance(timestamps: readonly number[], now: number): number {
  const recent = timestamps.filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  return Math.max(0, RATE_LIMIT_MAX - recent.length);
}

export function pruneRateWindow(timestamps: readonly number[], now: number): number[] {
  return timestamps.filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
}

export interface ShowNotificationOptions {
  /** Injected in tests; defaults to the platform constructor. */
  onNavigate?: (url: string) => void;
}

/**
 * Fire one notification. Returns the live handle (or `null` when the platform
 * refuses) so callers can close it when the underlying row resolves.
 */
export function showBrowserNotification(
  payload: NotificationPayload,
  options: ShowNotificationOptions = {},
): Notification | null {
  if (getNotificationPermission() !== "granted") return null;
  try {
    const notification = new window.Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      // Never re-alert for a replaced tag: an updated row should refresh the
      // popup silently, not buzz again.
      renotify: false,
      silent: false,
    } as NotificationOptions);
    notification.onclick = () => {
      try {
        window.focus();
        if (payload.url) {
          const navigate = options.onNavigate;
          if (navigate) navigate(payload.url);
          else window.location.assign(payload.url);
        }
      } finally {
        notification.close();
      }
    };
    return notification;
  } catch {
    return null;
  }
}
