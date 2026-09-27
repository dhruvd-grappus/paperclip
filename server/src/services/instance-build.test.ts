import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readInstanceBuildInfo } from "./instance-build.js";

describe("readInstanceBuildInfo", () => {
  const dirs: string[] = [];
  const distWith = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "instance-build-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return pathToFileURL(`${dir}/`);
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a fork build with its changelog and drops malformed commits", () => {
    const info = readInstanceBuildInfo(distWith({
      "grappus-build.json": JSON.stringify({
        commit: "90c66cab6fd8adee925bfc15c05f39d95944f456",
        base: "2026.916.1",
        build: "2",
        branch: "grappus/stable",
        builtAt: "2026-09-27T10:00:00.000Z",
        repositoryUrl: "https://github.com/dhruvd-grappus/paperclip",
        commits: [
          { sha: "90c66cab6fd8adee925bfc15c05f39d95944f456", subject: "fix(recovery): keep the lock", body: "why", author: "Dhruv", committedAt: "2026-09-27T15:39:40+05:30" },
          { sha: "", subject: "no sha" },
          "garbage",
        ],
      }),
      "build-info.json": JSON.stringify({ commit: "ignored" }),
    }));
    expect(info).toMatchObject({
      commit: "90c66cab6fd8adee925bfc15c05f39d95944f456",
      shortCommit: "90c66cab6",
      base: "2026.916.1",
      build: "2",
      branch: "grappus/stable",
    });
    expect(info.commits).toEqual([{
      sha: "90c66cab6fd8adee925bfc15c05f39d95944f456",
      shortSha: "90c66cab6",
      subject: "fix(recovery): keep the lock",
      body: "why",
      author: "Dhruv",
      committedAt: "2026-09-27T15:39:40+05:30",
    }]);
  });

  it("falls back to the upstream build stamp, then to nothing", () => {
    expect(readInstanceBuildInfo(distWith({ "build-info.json": JSON.stringify({ commit: "d554c4789" }) })))
      .toMatchObject({ commit: "d554c4789", shortCommit: "d554c4789", build: null, commits: [] });
    expect(readInstanceBuildInfo(distWith({ "grappus-build.json": "{not json" })))
      .toMatchObject({ commit: null, commits: [] });
  });
});
