import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inline the package version at build time so the CLI reports the released
// version without reading package.json at runtime (release.ts keeps it in sync).
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  define: { __CLI_VERSION__: JSON.stringify(version) },
  // Bundle the workspace packages (@repo/core, @repo/onboarding) INTO the
  // output. They're never published to npm, so an npx-installed `openship`
  // must carry them inline — otherwise it fails with ERR_MODULE_NOT_FOUND.
  // Runtime deps (commander, chalk, ora, open) stay external and come from
  // the published package's own dependencies.
  noExternal: [/^@repo\//],
});
