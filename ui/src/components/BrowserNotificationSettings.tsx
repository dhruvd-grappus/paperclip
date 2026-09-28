import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBrowserNotificationControls } from "@/hooks/useBrowserNotifications";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
} from "@/lib/browser-notifications";

function Row({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <ToggleSwitch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  );
}

/**
 * Settings panel for OS-level notifications (GRA-294). The permission prompt
 * fires from the enable button because browsers only honour it inside a user
 * gesture — and a prompt the user did not ask for is the fastest route to a
 * permanent deny.
 */
export function BrowserNotificationSettings() {
  const { permission, prefs, update, enable, disable } = useBrowserNotificationControls();
  const granted = permission === "granted";
  const controlsDisabled = !granted || !prefs.enabled;

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-start gap-2">
        <Bell className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Browser notifications</h2>
          <p className="text-sm text-muted-foreground">
            Paperclip notifies you only about work that cannot move without you — never about agent
            progress or routine confirmations. Notifications are per browser.
          </p>
        </div>
      </div>

      {permission === "unsupported" ? (
        <p className="text-sm text-muted-foreground">
          This browser does not support notifications.
        </p>
      ) : permission === "denied" ? (
        <p className="text-sm text-muted-foreground">
          Notifications are blocked for this site. Allow them in your browser&rsquo;s site settings,
          then reload this page.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {granted && prefs.enabled ? (
            <Button type="button" variant="secondary" onClick={disable}>
              Turn off notifications
            </Button>
          ) : (
            <Button type="button" onClick={() => void enable()}>
              {granted ? "Turn on notifications" : "Enable notifications"}
            </Button>
          )}
          {granted ? null : (
            <span className="text-sm text-muted-foreground">Your browser will ask for permission.</span>
          )}
        </div>
      )}

      <div className="divide-y divide-border/70 border-t border-border/70">
        {NOTIFICATION_CATEGORIES.map((category) => {
          const meta = NOTIFICATION_CATEGORY_META[category];
          return (
            <Row
              key={category}
              label={meta.label}
              description={meta.description}
              checked={prefs.categories[category]}
              disabled={controlsDisabled}
              onCheckedChange={(next) => update({ categories: { ...prefs.categories, [category]: next } })}
            />
          );
        })}
        <Row
          label="Only when Paperclip is not focused"
          description="Skip notifications while you are looking at this tab — the sidebar badge already shows them."
          checked={prefs.onlyWhenUnfocused}
          disabled={controlsDisabled}
          onCheckedChange={(next) => update({ onlyWhenUnfocused: next })}
        />
        <Row
          label="High and critical only"
          description="Hold everything below high severity for the Decisions queue."
          checked={prefs.minSeverityHigh}
          disabled={controlsDisabled}
          onCheckedChange={(next) => update({ minSeverityHigh: next })}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Each item notifies once. Bursts collapse into a single summary, and Paperclip sends at most
        five notifications a minute.
      </p>
    </Card>
  );
}
