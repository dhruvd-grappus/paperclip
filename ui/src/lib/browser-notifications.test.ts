// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DIGEST_THRESHOLD,
  NOTIFICATION_PREFS_KEY,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  buildItemNotification,
  categoryForSourceKind,
  getNotificationPermission,
  loadDeliveredKeys,
  loadNotificationPreferences,
  planNotifications,
  pruneRateWindow,
  rateLimitAllowance,
  saveDeliveredKeys,
  saveNotificationPreferences,
  selectNotifiableItems,
  shouldNotifyForVisibility,
  showBrowserNotification,
  type NotificationPreferences,
} from "./browser-notifications";

function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "approval",
    subject: {
      kind: "approval",
      id: "s1",
      companyId: "c1",
      title: "Ship the release",
      identifier: "GRA-1",
      status: null,
      href: "/company/issues/GRA-1",
    },
    whyNow: "Waiting on your approval",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "d1",
    dismissalKey: "attention:d1",
    severity: "medium",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedIssue: null,
    project: null,
    workspace: null,
    expiresAt: null,
    ruleKey: null,
    originAgentName: null,
    queues: [],
    shelf: false,
    retentionDays: 30,
    keep: false,
    archivedAt: null,
    retentionVersion: 1,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    detail: null,
    dismissal: null,
    trainingExampleId: null,
    ...overrides,
  };
}

const allOn: NotificationPreferences = {
  ...DEFAULT_NOTIFICATION_PREFERENCES,
  enabled: true,
  categories: { decisions: true, failures: true, budget: true, reviews: true },
};

describe("notification preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to off with the noisy review lane muted", () => {
    const prefs = loadNotificationPreferences();
    expect(prefs.enabled).toBe(false);
    expect(prefs.categories.decisions).toBe(true);
    expect(prefs.categories.reviews).toBe(false);
    expect(prefs.onlyWhenUnfocused).toBe(true);
  });

  it("round-trips saved preferences and survives corrupt storage", () => {
    saveNotificationPreferences({ ...allOn, minSeverityHigh: true });
    expect(loadNotificationPreferences()).toEqual({ ...allOn, minSeverityHigh: true });

    localStorage.setItem(NOTIFICATION_PREFS_KEY, "{not json");
    expect(loadNotificationPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });
});

describe("category routing", () => {
  it("maps every live source kind onto a mutable lane", () => {
    expect(categoryForSourceKind("approval")).toBe("decisions");
    expect(categoryForSourceKind("issue_thread_interaction")).toBe("decisions");
    expect(categoryForSourceKind("failed_run")).toBe("failures");
    expect(categoryForSourceKind("budget_alert")).toBe("budget");
    expect(categoryForSourceKind("review")).toBe("reviews");
  });

  it("drops the retired productivity_review source", () => {
    expect(categoryForSourceKind("productivity_review")).toBeNull();
  });
});

describe("selectNotifiableItems", () => {
  const now = Date.parse("2026-07-09T12:00:00Z");

  it("keeps rows in enabled categories only", () => {
    const items = [buildItem({ sourceKind: "approval" }), buildItem({ sourceKind: "review", dedupKey: "d2" })];
    const prefs = { ...allOn, categories: { ...allOn.categories, reviews: false } };
    expect(selectNotifiableItems(items, prefs, now).map((i) => i.dedupKey)).toEqual(["d1"]);
  });

  it("never notifies for low severity, and honours the high-only floor", () => {
    const low = buildItem({ severity: "low" });
    expect(selectNotifiableItems([low], allOn, now)).toEqual([]);

    const medium = buildItem({ severity: "medium" });
    expect(selectNotifiableItems([medium], allOn, now)).toHaveLength(1);
    expect(selectNotifiableItems([medium], { ...allOn, minSeverityHigh: true }, now)).toEqual([]);
  });

  it("respects the user's explicit not-now signals", () => {
    const snoozed = buildItem({ snoozedUntil: "2026-07-09T18:00:00Z" });
    const expired = buildItem({ dedupKey: "d2", snoozedUntil: "2026-07-09T06:00:00Z" });
    const dismissed = buildItem({
      dedupKey: "d3",
      dismissal: { dismissedAt: "2026-07-09T11:00:00Z" } as AttentionItem["dismissal"],
    });
    const archived = buildItem({ dedupKey: "d4", archivedAt: "2026-07-09T11:00:00Z" });

    const kept = selectNotifiableItems([snoozed, expired, dismissed, archived], allOn, now);
    expect(kept.map((i) => i.dedupKey)).toEqual(["d2"]);
  });
});

describe("planNotifications", () => {
  it("notifies per item for small batches", () => {
    const items = [buildItem(), buildItem({ dedupKey: "d2", subject: { ...buildItem().subject, title: "Second" } })];
    const plan = planNotifications(items);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.title).toContain("Ship the release");
    expect(plan[0]!.url).toBe("/company/issues/GRA-1");
  });

  it("collapses a burst into one digest pointing at the queue", () => {
    const items = Array.from({ length: DIGEST_THRESHOLD + 1 }, (_, index) =>
      buildItem({ dedupKey: `d${index}` }),
    );
    const plan = planNotifications(items);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.title).toBe(`${items.length} decisions need you`);
    expect(plan[0]!.url).toBe("/company/decisions");
    expect(plan[0]!.tag).toBe("paperclip:attention:digest");
  });

  it("returns nothing for an empty batch", () => {
    expect(planNotifications([])).toEqual([]);
  });

  it("tags each item notification with its dedup key so re-shows replace", () => {
    expect(buildItemNotification(buildItem()).tag).toBe("paperclip:attention:d1");
  });
});

describe("rate limiting", () => {
  const now = 1_000_000;

  it("allows up to the cap inside the window and nothing beyond it", () => {
    expect(rateLimitAllowance([], now)).toBe(RATE_LIMIT_MAX);
    const full = Array.from({ length: RATE_LIMIT_MAX }, () => now - 1_000);
    expect(rateLimitAllowance(full, now)).toBe(0);
  });

  it("forgets timestamps older than the window", () => {
    const stale = [now - RATE_LIMIT_WINDOW_MS - 1, now - 1_000];
    expect(pruneRateWindow(stale, now)).toEqual([now - 1_000]);
    expect(rateLimitAllowance(stale, now)).toBe(RATE_LIMIT_MAX - 1);
  });
});

describe("delivered ledger", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips keys and ignores non-string junk", () => {
    saveDeliveredKeys(["a", "b"]);
    expect(loadDeliveredKeys()).toEqual(["a", "b"]);

    localStorage.setItem("paperclip:notifications:delivered", JSON.stringify(["a", 3, null]));
    expect(loadDeliveredKeys()).toEqual(["a"]);
  });

  it("trims to a bounded window keeping the newest keys", () => {
    saveDeliveredKeys(Array.from({ length: 600 }, (_, index) => `k${index}`));
    const stored = loadDeliveredKeys();
    expect(stored).toHaveLength(500);
    expect(stored.at(-1)).toBe("k599");
  });
});

describe("visibility gate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("suppresses while the tab is focused by default", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    expect(shouldNotifyForVisibility(allOn)).toBe(false);
    expect(shouldNotifyForVisibility({ ...allOn, onlyWhenUnfocused: false })).toBe(true);
  });

  it("notifies when the tab is hidden", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    expect(shouldNotifyForVisibility(allOn)).toBe(true);
  });
});

describe("showBrowserNotification", () => {
  const original = (window as { Notification?: unknown }).Notification;

  afterEach(() => {
    (window as { Notification?: unknown }).Notification = original;
    vi.restoreAllMocks();
  });

  function installNotification(permission: string) {
    const instances: Array<{ title: string; options: NotificationOptions; close: () => void; onclick: null | (() => void) }> = [];
    class FakeNotification {
      static permission = permission;
      onclick: null | (() => void) = null;
      close = vi.fn();
      constructor(public title: string, public options: NotificationOptions) {
        instances.push(this as never);
      }
    }
    (window as { Notification?: unknown }).Notification = FakeNotification;
    return instances;
  }

  it("does nothing without permission", () => {
    const instances = installNotification("default");
    expect(getNotificationPermission()).toBe("default");
    expect(showBrowserNotification({ tag: "t", title: "T", body: "B", url: null })).toBeNull();
    expect(instances).toHaveLength(0);
  });

  it("emits a tagged, non-renotifying popup and navigates in-app on click", () => {
    const instances = installNotification("granted");
    const onNavigate = vi.fn();
    vi.spyOn(window, "focus").mockImplementation(() => {});

    showBrowserNotification({ tag: "paperclip:attention:d1", title: "T", body: "B", url: "/x" }, { onNavigate });

    expect(instances).toHaveLength(1);
    expect(instances[0]!.options.tag).toBe("paperclip:attention:d1");
    // `renotify` is not in lib.dom's NotificationOptions yet, but browsers
    // honour it — a replaced tag must refresh silently, not buzz again.
    expect((instances[0]!.options as { renotify?: boolean }).renotify).toBe(false);

    instances[0]!.onclick!();
    expect(onNavigate).toHaveBeenCalledWith("/x");
    expect(instances[0]!.close).toHaveBeenCalled();
  });

  it("reports unsupported platforms instead of throwing", () => {
    delete (window as { Notification?: unknown }).Notification;
    expect(getNotificationPermission()).toBe("unsupported");
    expect(showBrowserNotification({ tag: "t", title: "T", body: "B", url: null })).toBeNull();
  });
});
