/**
 * Resolve the calling client's IP address for rate-limiting / audit logging.
 *
 * Precedence:
 *   1. `X-Forwarded-For` (first hop) - set by reverse proxies (Caddy, nginx).
 *   2. `X-Real-IP`                   - alternate proxy convention.
 *   3. Bun's socket-level remote address via `getConnInfo`.
 *   4. "unknown" if nothing is available (shouldn't happen in practice).
 *
 * NOTE: proxy headers are only meaningful when a trusted proxy sets them.
 * If you expose this server directly to the internet without a proxy, an
 * attacker can spoof XFF and dodge the rate limiter. Production deploys
 * should always sit behind a reverse proxy that strips/rewrites these
 * headers before they reach this process.
 */

import { getConnInfo } from 'hono/bun';
import type { Context } from 'hono';

export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = c.req.header('x-real-ip')?.trim();
  if (realIp) return realIp;
  try {
    const info = getConnInfo(c);
    return info.remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
