#!/usr/bin/env bun
/**
 * Cut a new Openship release.
 *
 * Usage:
 *   bun scripts/release.ts patch          # 0.1.0      → 0.1.1
 *   bun scripts/release.ts minor          # 0.1.0      → 0.2.0
 *   bun scripts/release.ts major          # 0.1.0      → 1.0.0
 *   bun scripts/release.ts rc             # 0.1.0      → 0.1.1-rc.1
 *                                         # 0.1.1-rc.1 → 0.1.1-rc.2
 *                                         # 0.1.1-rc.2 → 0.1.1     (promote: rc → stable)
 *   bun scripts/release.ts <explicit>     # set to literal "0.2.0-beta.3"
 *   bun scripts/release.ts --dry-run patch
 *
 * What it does:
 *   1. Refuse if working tree is dirty
 *   2. Refuse if not on main (override with --force-branch)
 *   3. Refuse if HEAD is behind origin/main (you'd push an old commit)
 *   4. Compute next version from apps/api/package.json
 *   5. Sync both root package.json and apps/api/package.json
 *   6. Commit "Bump to vX.Y.Z"
 *   7. Push the bump commit to main
 *   8. Tag vX.Y.Z and push the tag
 *   9. Print the GitHub Actions URL so you can watch
 *
 * The tag-push triggers .github/workflows/release.yml which builds both
 * dist tarballs + SHA-256 sidecars and publishes a GitHub Release.
 * Tags containing `-` (rc.N, beta.N) become prereleases automatically.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT_PKG = join(ROOT, "package.json");
const API_PKG = join(ROOT, "apps/api/package.json");

/* ─── CLI parsing ──────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const forceBranch = args.includes("--force-branch");
const cmd = args.find((a) => !a.startsWith("--"));
if (!cmd) usageAndExit();

type BumpKind = "patch" | "minor" | "major" | "rc" | "literal";
const bump: { kind: BumpKind; literal?: string } =
  cmd === "patch" || cmd === "minor" || cmd === "major" || cmd === "rc"
    ? { kind: cmd }
    : { kind: "literal", literal: cmd };

if (bump.kind === "literal" && !/^\d+\.\d+\.\d+(-[a-z0-9]+(\.\d+)?)?$/i.test(bump.literal!)) {
  console.error(`Refusing literal version "${bump.literal}" — not a semver string.`);
  process.exit(1);
}

/* ─── Pre-flight checks ────────────────────────────────────────────── */

if (!dryRun) {
  preflight();
}

/* ─── Version compute ──────────────────────────────────────────────── */

const currentApi = readVersion(API_PKG);
const currentRoot = readVersion(ROOT_PKG);
if (currentApi !== currentRoot) {
  log(
    `⚠️  Version drift detected: root=${currentRoot}, apps/api=${currentApi}. ` +
      `Bumping from apps/api's (operative) value.`,
  );
}

const next = computeNext(currentApi, bump);
const tag = `v${next}`;

log(`Current version (apps/api): ${currentApi}`);
log(`Next version:               ${next}`);
log(`Tag:                        ${tag}`);
log(`Prerelease:                 ${tag.includes("-") ? "yes" : "no"}`);
log(``);

if (dryRun) {
  log(`[dry-run] would update:`);
  log(`  - ${API_PKG}`);
  log(`  - ${ROOT_PKG}`);
  log(`[dry-run] would commit + push to main, then tag + push ${tag}`);
  log(`[dry-run] no files written, no git ops executed.`);
  process.exit(0);
}

/* ─── Apply ─────────────────────────────────────────────────────────── */

writeVersion(API_PKG, next);
writeVersion(ROOT_PKG, next);
log(`✓ updated package.json files`);

git("add", API_PKG, ROOT_PKG);
git("commit", "-m", `Bump to ${tag}`);
log(`✓ committed`);

git("push", "origin", currentBranch());
log(`✓ pushed bump commit`);

git("tag", tag);
git("push", "origin", tag);
log(`✓ pushed tag ${tag}`);

/* ─── Final report ─────────────────────────────────────────────────── */

const remoteUrl = git("remote", "get-url", "origin", { capture: true }).trim();
const ghMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
if (ghMatch) {
  const [, owner, repo] = ghMatch;
  log(``);
  log(`Release pipeline triggered. Watch at:`);
  log(`  https://github.com/${owner}/${repo}/actions`);
  log(``);
  log(`Once it finishes, the release will appear at:`);
  log(`  https://github.com/${owner}/${repo}/releases/tag/${tag}`);
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

function usageAndExit(): never {
  console.error(
    [
      "Usage: bun scripts/release.ts <patch|minor|major|rc|x.y.z[-rc.N]> [--dry-run] [--force-branch]",
      "",
      "  patch          0.1.0      → 0.1.1",
      "  minor          0.1.0      → 0.2.0",
      "  major          0.1.0      → 1.0.0",
      "  rc             0.1.0      → 0.1.1-rc.1",
      "                 0.1.1-rc.1 → 0.1.1-rc.2",
      "                 0.1.1-rc.2 → 0.1.1   (rc → stable promotion)",
      "  <literal>      explicit semver string",
      "",
      "  --dry-run      print the plan, don't touch anything",
      "  --force-branch run from a non-main branch (default refuses)",
    ].join("\n"),
  );
  process.exit(1);
}

function preflight(): void {
  // 1. Clean working tree
  const status = git("status", "--porcelain", { capture: true }).trim();
  if (status) {
    console.error(
      `Refusing: working tree is dirty. Commit or stash first.\n${status}`,
    );
    process.exit(1);
  }

  // 2. On main
  const branch = currentBranch();
  if (branch !== "main" && !forceBranch) {
    console.error(
      `Refusing: current branch is "${branch}", not "main". ` +
        `Pass --force-branch to release from a different branch.`,
    );
    process.exit(1);
  }

  // 3. Up-to-date with origin (refuse if behind — would push a stale tag)
  git("fetch", "origin", branch);
  const behind = git("rev-list", "--count", `HEAD..origin/${branch}`, { capture: true }).trim();
  if (behind !== "0") {
    console.error(
      `Refusing: local "${branch}" is ${behind} commit(s) behind origin. Pull first.`,
    );
    process.exit(1);
  }
}

function currentBranch(): string {
  return git("rev-parse", "--abbrev-ref", "HEAD", { capture: true }).trim();
}

function readVersion(pkgPath: string): string {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  if (!pkg.version) {
    console.error(`Refusing: ${pkgPath} has no "version" field.`);
    process.exit(1);
  }
  return pkg.version;
}

function writeVersion(pkgPath: string, next: string): void {
  const raw = readFileSync(pkgPath, "utf8");
  // Preserve formatting + trailing newline. Surgical replacement of the
  // version field rather than full re-serialization avoids reformatting
  // the whole file (which would create noisy diffs).
  const replaced = raw.replace(
    /("version"\s*:\s*")[^"]+(")/,
    (_, a, b) => `${a}${next}${b}`,
  );
  if (replaced === raw) {
    console.error(`Refusing: could not locate version field in ${pkgPath}.`);
    process.exit(1);
  }
  writeFileSync(pkgPath, replaced);
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** e.g. "rc.1", "beta.3" — undefined when stable. */
  prerelease?: string;
}

function parseSemver(v: string): SemverParts {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) {
    console.error(`Refusing: "${v}" is not a parseable semver.`);
    process.exit(1);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  };
}

function formatSemver(p: SemverParts): string {
  const base = `${p.major}.${p.minor}.${p.patch}`;
  return p.prerelease ? `${base}-${p.prerelease}` : base;
}

function computeNext(current: string, bump: { kind: BumpKind; literal?: string }): string {
  if (bump.kind === "literal") return bump.literal!;
  const parsed = parseSemver(current);
  switch (bump.kind) {
    case "patch":
      return formatSemver({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + (parsed.prerelease ? 0 : 1) });
    case "minor":
      return formatSemver({ major: parsed.major, minor: parsed.minor + 1, patch: 0 });
    case "major":
      return formatSemver({ major: parsed.major + 1, minor: 0, patch: 0 });
    case "rc": {
      // rc → next rc OR rc → stable promotion
      if (parsed.prerelease) {
        const rcMatch = parsed.prerelease.match(/^rc\.(\d+)$/);
        if (rcMatch) {
          // currently rc.N — bump to rc.(N+1)
          return formatSemver({ ...parsed, prerelease: `rc.${Number(rcMatch[1]) + 1}` });
        }
        // some other prerelease (beta.N etc.) — bump patch + start rc.1
        return formatSemver({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch + 1,
          prerelease: "rc.1",
        });
      }
      // stable → next patch rc.1
      return formatSemver({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
        prerelease: "rc.1",
      });
    }
  }
}

function git(
  ...args: [string, ...(string | { capture: true })[]]
): string;
function git(
  ...args: string[]
): string;
function git(...args: (string | { capture: true })[]): string {
  const last = args[args.length - 1];
  const capture = typeof last === "object" && last !== null && (last as { capture?: boolean }).capture === true;
  const realArgs = (capture ? args.slice(0, -1) : args) as string[];
  const result = spawnSync("git", realArgs, {
    cwd: ROOT,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`git ${realArgs.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
  return capture ? (result.stdout ?? "") : "";
}

function log(msg: string): void {
  console.log(msg);
}
