import type { WorkspaceDetector } from "./types";

/**
 * Gradle multi-project - `settings.gradle` or `settings.gradle.kts` declares
 * the included sub-projects via `include` calls:
 *
 *     include 'app', 'libs:shared'
 *     include(":services:api")
 *     include ":services:worker"
 *
 * Gradle uses colon-prefixed paths (`:services:api`); we convert them to
 * slash-separated filesystem paths (`services/api`) since that's how the rest
 * of the codebase references project roots.
 *
 * Comments (`//`, `/* … *\/`) are stripped before matching.
 */
function parseGradleSettings(content: string): string[] {
  // Strip block comments first, then line comments.
  const cleaned = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  const paths: string[] = [];
  const includePattern = /include\s*(?:\(\s*)?((?:[^()\n]+))(?:\))?/g;

  let match: RegExpExecArray | null;
  while ((match = includePattern.exec(cleaned)) !== null) {
    const args = match[1];
    // Skip Gradle settings-level calls like `includeBuild` (which composes builds, not modules).
    if (/^Build\b/.test(args)) continue;
    // Capture every quoted string in this include() call.
    const stringPattern = /"([^"]+)"|'([^']+)'/g;
    let stringMatch: RegExpExecArray | null;
    while ((stringMatch = stringPattern.exec(args)) !== null) {
      const raw = (stringMatch[1] ?? stringMatch[2] ?? "").trim();
      if (!raw) continue;
      const path = raw.replace(/^:+/, "").replace(/:/g, "/").trim();
      if (path) paths.push(path);
    }
  }

  // Dedupe.
  const seen = new Set<string>();
  return paths.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

export const gradleWorkspaceDetector: WorkspaceDetector = {
  id: "gradle",
  label: "Gradle",
  manifestFiles: ["settings.gradle", "settings.gradle.kts"],
  packageManager: "gradle",
  parseSubProjects: parseGradleSettings,
};
