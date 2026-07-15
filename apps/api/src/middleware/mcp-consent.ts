import type { Context, Next } from "hono";

/**
 * Force the MCP OAuth authorize flow through our consent page.
 *
 * better-auth's mcp() plugin only redirects `/mcp/authorize` to the configured
 * `consentPage` when `prompt === "consent"` EXACTLY; for any other value (or
 * none) it mints an authorization code immediately and the consent page never
 * runs. Our consent page (`dashboard/mcp/authorize` → POST /api/tokens/mcp-
 * authorize) is the ONLY writer of the OAuth binding (org + scope) that
 * `tryOAuthMcpAuth` requires — so a token minted on the bypass path has no
 * binding and is denied everything. Standard MCP clients (Claude, Cursor) don't
 * send `prompt=consent`, so we inject it: if it isn't exactly "consent", 302
 * back to the same authorize URL with the param forced (all other params —
 * client_id, redirect_uri, code_challenge, state — preserved). Consent then
 * always runs and the binding is always created. The redirected request (and
 * better-auth's post-login authorize replay) already carries "consent", so
 * there's no loop. Must be mounted BEFORE the /api/auth catch-all.
 */
export async function forceMcpConsent(c: Context, next: Next): Promise<Response | void> {
  const url = new URL(c.req.url);
  if (url.searchParams.get("prompt") !== "consent") {
    url.searchParams.set("prompt", "consent");
    return c.redirect(url.toString(), 302);
  }
  return next();
}
