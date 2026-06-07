import type { LanguageDetector } from "./types";

/**
 * PHP - `composer.json` `require` + `require-dev` blocks. Keys are package
 * names (`vendor/package`) and values are version constraints.
 */
function parseComposerJson(content: string): Record<string, string> {
  let parsed: { require?: Record<string, string>; "require-dev"?: Record<string, string> };
  try {
    parsed = JSON.parse(content);
  } catch {
    return {};
  }
  return { ...(parsed.require ?? {}), ...(parsed["require-dev"] ?? {}) };
}

export const phpLanguageDetector: LanguageDetector = {
  id: "php",
  label: "PHP",
  manifestFiles: ["composer.json"],
  parseManifest: (_filename, content) => parseComposerJson(content),
};
