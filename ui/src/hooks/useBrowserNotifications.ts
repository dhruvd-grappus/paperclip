import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { attentionApi } from "../api/attention";
import { queryKeys } from "../lib/queryKeys";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFS_KEY,
  getNotificationPermission,
  loadDeliveredKeys,
  loadNotificationPreferences,
  planNotifications,
  pruneRateWindow,
  rateLimitAllowance,
  requestNotificationPermission,
  saveDeliveredKeys,
  saveNotificationPreferences,
  selectNotifiableItems,
  shouldNotifyForVisibility,
  showBrowserNotification,
  type NotificationPermissionState,
  type NotificationPreferences,
} from "../lib/browser-notifications";

/** Same cadence as the sidebar attention badge — no extra polling pressure. */
const ATTENTION_POLL_MS = 60_000;

/**
 * Preferences as shared state: the settings panel and the background notifier
 * both read this, and a change in one tab reaches the others through the
 * `storage` event (a second tab that kept notifying after the user muted here
 * would look like a bug in the mute).
 */
export function useNotificationPreferences() {
  const [prefs, setPrefs] = useState<NotificationPreferences>(() => {
    if (typeof window === "undefined") return DEFAULT_NOTIFICATION_PREFERENCES;
    return loadNotificationPreferences();
  });

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== NOTIFICATION_PREFS_KEY) return;
      setPrefs(loadNotificationPreferences());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const update = useCallback((patch: Partial<NotificationPreferences>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch, categories: { ...current.categories, ...patch.categories } };
      saveNotificationPreferences(next);
      return next;
    });
  }, []);

  return { prefs, update };
}

export interface BrowserNotificationControls {
  permission: NotificationPermissionState;
  prefs: NotificationPreferences;
  update: (patch: Partial<NotificationPreferences>) => void;
  /** Call from a click handler only — browsers reject background prompts. */
  enable: () => Promise<NotificationPermissionState>;
  disable: () => void;
}

export function useBrowserNotificationControls(): BrowserNotificationControls {
  const { prefs, update } = useNotificationPreferences();
  const [permission, setPermission] = useState<NotificationPermissionState>(() => getNotificationPermission());

  const enable = useCallback(async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    // Only flip the master switch on a real grant, so the settings row never
    // claims notifications are on while the OS is dropping them.
    update({ enabled: result === "granted" });
    return result;
  }, [update]);

  const disable = useCallback(() => {
    update({ enabled: false });
  }, [update]);

  return { permission, prefs, update, enable, disable };
}

/**
 * Background notifier. Mount once in the authenticated shell.
 *
 * Every gate lives in `lib/browser-notifications`; this hook only sequences
 * them against the attention feed and owns the two pieces of mutable state
 * that must survive re-renders: the delivered-key ledger and the rate window.
 */
export function useBrowserNotifications(companyId: string | null | undefined) {
  const navigate = useNavigate();
  const { prefs } = useNotificationPreferences();
  const permission = getNotificationPermission();
  const active = prefs.enabled && permission === "granted" && !!companyId;

  const deliveredRef = useRef<Set<string> | null>(null);
  if (deliveredRef.current === null) {
    deliveredRef.current = new Set(typeof window === "undefined" ? [] : loadDeliveredKeys());
  }
  const rateWindowRef = useRef<number[]>([]);
  // Live handles, so a decision resolved elsewhere stops shouting here.
  const openRef = useRef(new Map<string, Notification>());

  const { data: feed } = useQuery({
    queryKey: queryKeys.attention(companyId!),
    queryFn: () => attentionApi.list(companyId!),
    enabled: active,
    refetchInterval: ATTENTION_POLL_MS,
  });

  const items = useMemo(() => feed?.items ?? [], [feed]);

  useEffect(() => {
    if (!active || !feed) return;
    const delivered = deliveredRef.current!;
    const now = Date.now();

    const eligible = selectNotifiableItems(items, prefs, now);
    const liveKeys = new Set(eligible.map((item) => item.dedupKey));

    // Close popups whose row left the feed (resolved, snoozed, dismissed).
    for (const [key, notification] of openRef.current) {
      if (liveKeys.has(key)) continue;
      notification.close();
      openRef.current.delete(key);
    }

    const fresh = eligible.filter((item) => !delivered.has(item.dedupKey));
    if (fresh.length === 0) return;

    // Mark first, show second. A row the user is already looking at (focused
    // tab) is still "delivered" — the badge did the job, and re-announcing it
    // the moment they switch away is exactly the spam this guards against.
    for (const item of fresh) delivered.add(item.dedupKey);
    saveDeliveredKeys([...delivered]);

    if (!shouldNotifyForVisibility(prefs)) return;

    rateWindowRef.current = pruneRateWindow(rateWindowRef.current, now);
    const allowance = rateLimitAllowance(rateWindowRef.current, now);
    if (allowance <= 0) return;

    const payloads = planNotifications(fresh).slice(0, allowance);
    for (const payload of payloads) {
      const notification = showBrowserNotification(payload, { onNavigate: (url) => navigate(url) });
      rateWindowRef.current.push(now);
      if (!notification) continue;
      const key = fresh.find((item) => payload.tag.endsWith(item.dedupKey))?.dedupKey;
      if (key) openRef.current.set(key, notification);
    }
  }, [active, feed, items, prefs, navigate]);

  useEffect(() => {
    const open = openRef.current;
    return () => {
      for (const notification of open.values()) notification.close();
      open.clear();
    };
  }, []);
}
