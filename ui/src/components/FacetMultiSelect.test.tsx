// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FacetMultiSelect, type FacetOption } from "./FacetMultiSelect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: FacetOption[] = [
  { value: "user-1", label: "Ada", count: 3 },
  { value: "user-2", label: "Grace", count: 1 },
  { value: "unassigned", label: "No owner", count: 2 },
];

describe("FacetMultiSelect", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(selected: string[], onChange = vi.fn()) {
    flushSync(() => {
      root.render(
        <FacetMultiSelect
          label="people"
          allLabel="Anyone · 6"
          options={OPTIONS}
          selected={selected}
          onChange={onChange}
          testId="facet"
        />,
      );
    });
    return onChange;
  }

  function trigger() {
    return container.querySelector<HTMLButtonElement>('[data-testid="facet"]')!;
  }

  function open() {
    flushSync(() => trigger().click());
  }

  /** The popover portals to the body, so options are looked up there. */
  function optionLabels() {
    return [...document.querySelectorAll("label")].map((el) => el.textContent ?? "");
  }

  it("reads as unfiltered when nothing is ticked", () => {
    render([]);
    expect(trigger().textContent).toContain("Anyone · 6");
  });

  it("names a single selection and counts several", () => {
    render(["user-2"]);
    expect(trigger().textContent).toContain("Grace");

    render(["user-1", "unassigned"]);
    expect(trigger().textContent).toContain("2 people");
  });

  it("adds to the selection rather than replacing it", () => {
    const onChange = render(["user-1"]);
    open();
    const grace = [...document.querySelectorAll("label")].find((el) =>
      el.textContent?.includes("Grace"),
    )!;
    flushSync(() => grace.querySelector("button")!.click());
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining(["user-1", "user-2"]));
    expect(onChange.mock.calls[0][0]).toHaveLength(2);
  });

  it("unticks a value that is already selected", () => {
    const onChange = render(["user-1", "user-2"]);
    open();
    const ada = [...document.querySelectorAll("label")].find((el) =>
      el.textContent?.includes("Ada"),
    )!;
    flushSync(() => ada.querySelector("button")!.click());
    expect(onChange).toHaveBeenCalledWith(["user-2"]);
  });

  it("offers every option with its count, including the null bucket", () => {
    render([]);
    open();
    const labels = optionLabels();
    expect(labels.some((text) => text.includes("Ada") && text.includes("3"))).toBe(true);
    expect(labels.some((text) => text.includes("No owner") && text.includes("2"))).toBe(true);
  });

  it("clears back to unfiltered", () => {
    const onChange = render(["user-1"]);
    open();
    const clear = [...document.querySelectorAll("button")].find(
      (el) => el.textContent === "Clear",
    )!;
    flushSync(() => clear.click());
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
