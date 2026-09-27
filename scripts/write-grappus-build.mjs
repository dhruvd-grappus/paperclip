#!/usr/bin/env node
// Write server/dist/grappus-build.json: the running commit, the upstream tag it
// is based on, and every commit since that tag (the sidebar changelog).
//
//   node scripts/write-grappus-build.mjs <upstream base version> [build number]
//
// Read by server/src/services/instance-build.ts. Merge commits are skipped so
// the changelog lists the changes themselves.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const [base, buildArg] = process.argv.slice(2);
if (!base) {
  console.error("usage: write-grappus-build.mjs <upstream base version> [build number]");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const range = `v${base}..HEAD`;
const FIELD = "\x1f";
const RECORD = "\x1e";
const log = git("log", "--no-merges", `--format=%H${FIELD}%h${FIELD}%an${FIELD}%cI${FIELD}%s${FIELD}%b${RECORD}`, range);
const commits = log
  .split(RECORD)
  .map((record) => record.replace(/^\n+/, ""))
  .filter(Boolean)
  .map((record) => {
    const [sha, shortSha, author, committedAt, subject, body = ""] = record.split(FIELD);
    return {
      sha,
      shortSha,
      author,
      committedAt,
      subject,
      // Trailers are noise in a changelog.
      body: body.replace(/\n*Co-Authored-By:.*$/gim, "").trim(),
    };
  });

const info = {
  commit: git("rev-parse", "HEAD"),
  shortCommit: git("rev-parse", "--short=9", "HEAD"),
  base,
  build: buildArg ?? git("rev-list", "--count", range),
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  builtAt: new Date().toISOString(),
  repositoryUrl: "https://github.com/dhruvd-grappus/paperclip",
  commits,
};
const out = join(repoRoot, "server", "dist", "grappus-build.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.log(`grappus-build.json: ${info.shortCommit} build ${info.build}, ${commits.length} commit(s) since v${base}`);
