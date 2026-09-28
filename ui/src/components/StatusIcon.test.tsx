// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ISSUE_STATUSES } from "@paperclipai/shared";
import { StatusIcon, offeredStatuses } from "./StatusIcon";

/**
 * StatusIcon renders the unified {@link StatusGlyph} (one shape per status) at
 * every standalone status surface. These tests lock the glyph rendering, the
 * covered-blocked → "in queue" mapping, the accessible blocked labels, and the
 * size prop.
 */
describe("StatusIcon", () => {
  it("renders the unified glyph (24-unit viewBox), not a bespoke ring", () => {
    const html = renderToStaticMarkup(<StatusIcon status="in_progress" />);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).not.toContain("rounded-full border-2");
  });

  it("drives the glyph colour from the status icon var", () => {
    const html = renderToStaticMarkup(<StatusIcon status="todo" />);
    expect(html).toContain("var(--status-task-icon-todo)");
  });

  it("maps covered-blocked → In queue (blue in_queue var, no cyan markers)", () => {
    const html = renderToStaticMarkup(
      <StatusIcon
        status="blocked"
        blockerAttention={{
          state: "covered",
          reason: "active_child",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          attentionBlockerCount: 0,
          stalledBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-9",
          sampleStalledBlockerIdentifier: null,
        }}
      />,
    );
    expect(html).toContain("var(--status-task-icon-in_queue)");
    expect(html).not.toContain("bg-cyan");
    expect(html).not.toContain("border-cyan");
    // Full blocked reason still rides on the accessible label.
    expect(html).toContain("Blocked · waiting on active sub-task PAP-9");
  });

  it("surfaces attention-required blocked copy and keeps the blocked glyph", () => {
    const html = renderToStaticMarkup(
      <StatusIcon
        status="blocked"
        blockerAttention={{
          state: "needs_attention",
          reason: "attention_required",
          unresolvedBlockerCount: 3,
          coveredBlockerCount: 2,
          stalledBlockerCount: 0,
          attentionBlockerCount: 3,
          sampleBlockerIdentifier: "PAP-3541",
          sampleStalledBlockerIdentifier: null,
        }}
      />,
    );
    expect(html).toContain("Blocked · 3 blockers need attention; 2 covered by active work");
    // needs_attention is not "covered", so it keeps the blocked glyph (not in_queue).
    expect(html).toContain("var(--status-task-icon-blocked)");
    expect(html).not.toContain("var(--status-task-icon-in_queue)");
  });

  it("surfaces stalled-review blocked copy on the accessible label", () => {
    const html = renderToStaticMarkup(
      <StatusIcon
        status="blocked"
        blockerAttention={{
          state: "stalled",
          reason: "stalled_review",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 0,
          stalledBlockerCount: 1,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-2279",
          sampleStalledBlockerIdentifier: "PAP-2279",
        }}
      />,
    );
    expect(html).toContain("Blocked · review stalled on PAP-2279");
  });

  it("uses an accessible native button for the icon-only picker trigger", () => {
    const html = renderToStaticMarkup(<StatusIcon status="todo" onChange={() => {}} />);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="Change status (current: Todo)"');
  });

});

/**
 * GRA-274: `human_approved` shipped in ISSUE_STATUSES and rendered correctly
 * everywhere, but the picker's status list was a hand-copied array of the old
 * seven — so nothing in the product ever offered it and the status was
 * unreachable by a user. These lock the list against the shared constant.
 */
describe("StatusIcon — offered statuses", () => {
  it("offers every shared status when the task is done", () => {
    expect([...offeredStatuses("done")].sort()).toEqual([...ISSUE_STATUSES].sort());
  });

  it("offers human_approved from done, and from human_approved itself", () => {
    expect(offeredStatuses("done")).toContain("human_approved");
    expect(offeredStatuses("human_approved")).toContain("human_approved");
  });

  it("withholds human_approved elsewhere — the server only accepts it from done", () => {
    for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked", "cancelled"]) {
      expect(offeredStatuses(status)).not.toContain("human_approved");
    }
  });

  it("keeps human_approved next to done in the picker order", () => {
    const order = offeredStatuses("done");
    expect(order.indexOf("human_approved")).toBe(order.indexOf("done") + 1);
  });
});

describe("StatusIcon — glyph size (PAP-243a)", () => {
  it('forwards size="lg" as a 20px glyph', () => {
    const html = renderToStaticMarkup(<StatusIcon status="todo" size="lg" />);
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
  });

  it("defaults to a 16px (md) glyph when size is omitted", () => {
    const html = renderToStaticMarkup(<StatusIcon status="todo" />);
    expect(html).toContain('width="16"');
    expect(html).toContain('height="16"');
  });
});
