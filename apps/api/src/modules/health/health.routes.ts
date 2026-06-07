/**
 * Health check module - used by load balancers and Docker health checks.
 */
import { Hono } from "hono";
import { hostname, userInfo } from "node:os";
import { cloudRuntimeTarget, env } from "../../config/env";

/**
 * Best-effort friendly name for the local machine. On macOS with Bonjour
 * misconfigured, `os.hostname()` can return the LAN IP literal (e.g.
 * "192.168.1.8") instead of a name - useless in the sidebar. Treat any
 * IPv4/IPv6 literal as bogus and fall back to the unix username, which
 * the OS always has and renders nicely as a personal-machine identity.
 */
function resolveMachineName(): string | undefined {
  if (env.DEPLOY_MODE !== "desktop") return undefined;

  const raw = (() => {
    try {
      return hostname();
    } catch {
      return "";
    }
  })().trim();

  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw);
  const isIpv6 = raw.includes(":") && /^[0-9a-fA-F:]+$/.test(raw);
  if (raw && !isIpv4 && !isIpv6) return raw;

  try {
    const u = userInfo().username?.trim();
    if (u) return `${u[0].toUpperCase()}${u.slice(1)}`;
  } catch {
    /* fall through */
  }
  return undefined;
}

const machineName = resolveMachineName();

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

/** GET /health/env - static deployment info (no auth, cached by callers). */
healthRoutes.get("/env", async (c) => {
  // authMode tells the dashboard which login flow to use:
  //   "none"   → zero-auth, auto-provisioned local user (desktop default)
  //   "cloud"  → external auth on Openship Cloud
  //   "local"  → local Better Auth (self-hosted server / SaaS)
  let authMode: string;

  if (env.DEPLOY_MODE === "desktop") {
    // Desktop: authMode is set during onboarding (none or cloud)
    try {
      const { repos } = await import("@repo/db");
      const settings = await repos.instanceSettings.get();
      authMode = settings?.authMode ?? "none";
    } catch {
      authMode = "none";
    }
  } else {
    authMode = "local";
  }

  return c.json({
    selfHosted: !env.CLOUD_MODE,
    deployMode: env.DEPLOY_MODE,
    authMode,
    cloudAuthUrl: cloudRuntimeTarget.dashboard,
    ...(machineName && { machineName }),
    ...(env.HOST_DOMAIN && { hostDomain: env.HOST_DOMAIN }),
  });
});
