/**
 * Branding controller - thin HTTP handlers in front of branding.service.
 *
 * Mounted at `/api/mail/branding/:serverId` behind localOnly + auth in
 * `mail.routes.ts`. The service does the talking to the Zero webmail
 * server; we just map errors to status codes and pull params.
 */

import type { Context } from "hono";
import { env } from "../../config";
import {
  BrandingUnauthorizedError,
  BrandingUnreachableError,
  getBranding,
  updateBranding,
  type Branding,
} from "./branding.service";

function localOnlyGuard(c: Context): Response | null {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Not available in cloud mode" }, 404);
  }
  return null;
}

function requireServerId(c: Context): string {
  const id = c.req.param("serverId");
  if (!id) throw new Error("serverId is required");
  return id;
}

export async function getBrandingHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  try {
    const branding = await getBranding(serverId);
    return c.json({ branding });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function updateBrandingHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  const body = (await c.req.json().catch(() => ({}))) as Partial<Branding>;
  try {
    const branding = await updateBranding(serverId, body);
    return c.json({ branding });
  } catch (err) {
    return errorJson(c, err);
  }
}

function errorJson(c: Context, err: unknown) {
  if (err instanceof BrandingUnauthorizedError) {
    return c.json({ error: err.message }, 502);
  }
  if (err instanceof BrandingUnreachableError) {
    return c.json({ error: err.message }, 502);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
}
