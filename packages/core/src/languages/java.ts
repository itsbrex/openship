import type { LanguageDetector } from "./types";

/**
 * Java - `pom.xml` (Maven) and `build.gradle` / `build.gradle.kts` (Gradle)
 * mark the language. Today we don't extract a dep map from either format
 * (no Maven XML parser, no Gradle DSL parser) - those manifests are surfaced
 * here so the prepare service fetches them, and the stack detector relies on
 * STACKS `contentPatterns` to identify Spring Boot / Quarkus / etc. directly
 * from the manifest text.
 *
 * If Java dep extraction becomes worthwhile (e.g. for a Java framework whose
 * detection rule can't be expressed in `contentPatterns`), implement parsers
 * here and the registry plumbing requires no other changes.
 */
function parseJavaManifest(_filename: string, _content: string): Record<string, string> {
  return {};
}

export const javaLanguageDetector: LanguageDetector = {
  id: "java",
  label: "Java",
  manifestFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
  parseManifest: parseJavaManifest,
};
