import { describe, expect, it } from "vitest";
import { parseOpenCodeStdoutLine } from "./parse-stdout.js";

describe("parseOpenCodeStdoutLine", () => {
  it("maps ACP stream pieces to delta thinking and assistant entries, whitespace intact", () => {
    const ts = "2026-10-05T00:00:00.000Z";
    expect(parseOpenCodeStdoutLine(JSON.stringify({ type: "reasoning_delta", part: { text: "Let me " } }), ts)).toEqual([
      { kind: "thinking", ts, text: "Let me ", delta: true },
    ]);
    expect(parseOpenCodeStdoutLine(JSON.stringify({ type: "text_delta", part: { text: " done." } }), ts)).toEqual([
      { kind: "assistant", ts, text: " done.", delta: true },
    ]);
    expect(parseOpenCodeStdoutLine(JSON.stringify({ type: "text_delta", part: { text: "" } }), ts)).toEqual([]);
  });
});
