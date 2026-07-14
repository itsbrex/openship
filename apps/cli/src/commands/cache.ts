/**
 * `openship cache` — inspect and manage ~/.openship/cache, where `install`
 * stores downloaded desktop-app release assets and their .sha256 sidecars
 * (see lib/cache.ts). No API calls.
 *
 *   path    print the cache directory
 *   list    list cached release assets
 *   verify  re-hash each asset and compare to its sidecar
 *   clean   delete cached assets (optionally one tag)
 */
import { Command } from "commander";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CACHE_DIR,
  RELEASES_DIR,
  formatBytes,
  hashFile,
  parseSha256,
  releaseDir,
} from "../lib/cache";
import { err, info, isJsonMode, ok, printJson, printTable } from "../lib/output";

interface CachedAsset {
  tag: string;
  name: string;
  path: string;
  size: number;
  hasSidecar: boolean;
}

/** Walk cache/releases/<tag>/<asset>, skipping the .sha256 sidecars themselves. */
function listAssets(): CachedAsset[] {
  if (!existsSync(RELEASES_DIR)) return [];
  const out: CachedAsset[] = [];
  for (const tag of readdirSync(RELEASES_DIR)) {
    const dir = releaseDir(tag);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".sha256")) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({
        tag,
        name,
        path,
        size: st.size,
        hasSidecar: existsSync(`${path}.sha256`),
      });
    }
  }
  return out;
}

const pathCmd = new Command("path")
  .description("Print the cache directory path")
  .action(() => {
    if (isJsonMode()) printJson({ path: CACHE_DIR });
    else process.stdout.write(CACHE_DIR + "\n");
  });

const listCmd = new Command("list")
  .alias("ls")
  .description("List cached release assets")
  .action(() => {
    const assets = listAssets();
    printTable(
      assets.map((a) => ({
        tag: a.tag,
        asset: a.name,
        size: formatBytes(a.size),
        sidecar: a.hasSidecar ? "yes" : "no",
      })),
      ["tag", "asset", "size", "sidecar"],
    );
  });

const verifyCmd = new Command("verify")
  .description("Re-hash cached assets and compare to their .sha256 sidecar")
  .argument("[tag]", "Only verify assets under this release tag")
  .action(async (tag?: string) => {
    const assets = listAssets().filter((a) => !tag || a.tag === tag);
    const results: { tag: string; asset: string; result: string }[] = [];
    let bad = 0;

    for (const a of assets) {
      if (!a.hasSidecar) {
        results.push({ tag: a.tag, asset: a.name, result: "no-sidecar" });
        continue;
      }
      const expected = parseSha256(readFileSync(`${a.path}.sha256`, "utf8"));
      const actual = await hashFile(a.path);
      const okMatch = expected !== null && expected === actual;
      if (!okMatch) bad += 1;
      results.push({ tag: a.tag, asset: a.name, result: okMatch ? "ok" : "MISMATCH" });
    }

    if (isJsonMode()) {
      printJson({ verified: results.length, failed: bad, results });
    } else {
      printTable(results, ["tag", "asset", "result"]);
      if (results.length === 0) info("  Nothing cached to verify.");
    }
    if (bad > 0) process.exit(1);
  });

const cleanCmd = new Command("clean")
  .description("Delete cached release assets")
  .argument("[tag]", "Only remove this release tag (default: all)")
  .action((tag?: string) => {
    const target = tag ? releaseDir(tag) : RELEASES_DIR;
    if (!existsSync(target)) {
      if (isJsonMode()) printJson({ removed: false, path: target });
      else info(`  Nothing to clean (${target}).`);
      return;
    }
    rmSync(target, { recursive: true, force: true });
    if (isJsonMode()) printJson({ removed: true, path: target });
    else ok(`\n  Removed ${target}\n`);
  });

export const cacheCommand = new Command("cache")
  .description("Manage the local download cache (list/verify/clean/path)")
  .action(() => {
    err("Specify a subcommand: path | list | verify | clean");
    process.exit(1);
  })
  .addCommand(pathCmd)
  .addCommand(listCmd)
  .addCommand(verifyCmd)
  .addCommand(cleanCmd);
