/**
 * Shared service routing helpers used by both the dashboard and API.
 */

/** Normalize any input into a valid DNS subdomain label. */
export function normalizeServiceLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "service";
}

/**
 * Generate the default hostname label for a service.
 *
 * For compose services, "frontend-style" names ("web", "app", "frontend")
 * collapse to the bare project label - there's a strong implicit "main app"
 * in compose deploys and the UX expects "the web container" to live at
 * the project's base URL.
 *
 * For monorepo sub-apps that convention is wrong: every sub-app is a peer
 * and there's no implicit primary. Two monorepo apps named "web" + "admin"
 * would both have to live at distinct hostnames, so we always namespace.
 * Pass `kind="monorepo"` to opt out of the shortlist collapse.
 */
export function defaultServiceHostnameLabel(
  projectLabel: string,
  serviceName: string,
  kind: "compose" | "monorepo" = "compose",
): string {
  const base = normalizeServiceLabel(projectLabel);
  const normalizedService = normalizeServiceLabel(serviceName);

  if (kind === "compose" && ["web", "app", "frontend"].includes(normalizedService)) {
    return base;
  }

  return `${base}-${normalizedService}`;
}

/** Build the public hostname label for a service, preferring the explicit saved subdomain when present. */
export function resolveServiceHostnameLabel(
  projectLabel: string,
  serviceName: string,
  explicitSubdomain?: string | null,
  kind: "compose" | "monorepo" = "compose",
): string {
  return normalizeServiceLabel(
    explicitSubdomain || defaultServiceHostnameLabel(projectLabel, serviceName, kind),
  );
}