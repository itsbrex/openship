/**
 * TODO: Verify signature implementation against Oblien's exact HMAC
 * convention — they document the `X-Webhook-Signature` header, but the
 * exact stringification of the payload (whitespace, key ordering, JSON
 * canonicalization) may need tweaking once we get a real delivery to
 * inspect. Today this implements the conventional "HMAC-SHA256 over the
 * raw request body, hex digest, constant-time compare" pattern that
 * matches what most webhook providers ship. Cross-reference with the
 * Oblien SDK source the moment the first delivery lands, before
 * promoting this past staging.
 */

/**
 * Oblien webhook receiver — POST /api/billing/oblien-webhook.
 *
 * Single entry point for events Oblien fires against our endpoint
 * (registered out-of-band via `client.webhooks.create` when the org is
 * provisioned). Three event types matter today:
 *
 *   - `credits.depleted`            → suspend the namespace immediately
 *                                     via quotaWrapper.suspendIfExhausted,
 *                                     so the user-notified flow runs the
 *                                     instant Oblien knows, instead of
 *                                     waiting for the next poll.
 *   - `credits.low` (80%)           → soft warning email so the org can
 *                                     top up before they hit the cap.
 *   - `namespace.quota.threshold`   → same warning surface; Oblien's
 *                                     generic threshold event piggy-backs
 *                                     here when the integrator config
 *                                     uses the threshold API rather than
 *                                     the credits.low convenience event.
 *
 * Anything else is accepted (2xx) but treated as a no-op — we don't
 * want Oblien retrying events we haven't wired up yet.
 *
 * Signature verification: HMAC-SHA256 over the raw request body using
 * OBLIEN_WEBHOOK_SECRET (the value Oblien returned at webhooks.create).
 * Compared in constant time against the hex digest in
 * `X-Webhook-Signature`. Missing secret OR missing/mismatched header →
 * 401. The handler MUST run before c.req.json() — we need the exact
 * bytes Oblien signed.
 *
 * Idempotency: in-memory `Set` keyed on Oblien's event_id with a 1-hour
 * TTL. Oblien retries are bounded (small handful), so the wall-clock
 * window is enough to dedupe a redelivery storm without bloating
 * memory. A DB-backed dedupe (mirroring stripe_webhook_event) would be
 * stronger but adds a migration; we can graduate to it the moment we
 * see a duplicate slip past this window in production logs.
 *
 * Runs only when CLOUD_MODE=true — Oblien webhooks target the SaaS,
 * never a self-hosted instance.
 */

import type { Context } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, schema, eq } from "@repo/db";
import { safeErrorMessage } from "@repo/core";

import { env } from "../../config/env";
import { sendMail } from "../../lib/mail";
import * as quotaWrapper from "./billing-oblien-quota";

/* ───────── In-memory idempotency cache ──────────────────────────────────── */

/**
 * 1-hour TTL — Oblien retries are bounded (a handful at most), so this
 * window is comfortably longer than the retry envelope. Entries past TTL
 * are GC'd lazily on access so we don't need a background sweeper.
 */
const SEEN_EVENT_TTL_MS = 60 * 60 * 1000;
const seenEvents = new Map<string, number>();

function alreadyProcessed(eventId: string): boolean {
  const now = Date.now();
  const seen = seenEvents.get(eventId);
  if (seen && now - seen < SEEN_EVENT_TTL_MS) {
    return true;
  }
  // Lazy GC: every miss prunes a chunk of stale entries so the map can't
  // grow unbounded under steady traffic.
  if (seenEvents.size > 1024) {
    for (const [id, ts] of seenEvents) {
      if (now - ts >= SEEN_EVENT_TTL_MS) seenEvents.delete(id);
    }
  }
  return false;
}

function markProcessed(eventId: string): void {
  seenEvents.set(eventId, Date.now());
}

/* ───────── Signature verification ───────────────────────────────────────── */

/**
 * HMAC-SHA256(secret, rawBody) → hex. Constant-time compare against the
 * header value. Returns false on any shape mismatch (missing secret,
 * missing header, wrong length) so callers can return a single 401
 * without leaking which branch failed.
 */
function verifySignature(rawBody: string, signature: string | undefined): boolean {
  if (!env.OBLIEN_WEBHOOK_SECRET) return false;
  if (!signature) return false;

  const expected = createHmac("sha256", env.OBLIEN_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  // Oblien may prefix the digest with `sha256=` (Stripe/GitHub convention)
  // — tolerate either form so we don't have to wait for a confirming
  // delivery to know which they ship.
  const provided = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  if (provided.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    // Buffer.from on a non-hex string throws lazily on some inputs —
    // treat the failure as a mismatch rather than a 500.
    return false;
  }
}

/* ───────── Payload shapes ───────────────────────────────────────────────── */

/**
 * Narrow shape we read off the JSON. Oblien's webhooks all surface the
 * affected namespace + event id at the top level; per-event detail
 * lives under `data`. We extract defensively because the SDK doesn't
 * publish a typed envelope (yet).
 */
interface OblienWebhookPayload {
  event_id?: string;
  event?: string;
  namespace?: string;
  data?: {
    namespace?: string;
    threshold_percent?: number;
    used_percent?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function extractEventId(payload: OblienWebhookPayload): string | null {
  return typeof payload.event_id === "string" ? payload.event_id : null;
}

function extractEventType(payload: OblienWebhookPayload): string | null {
  return typeof payload.event === "string" ? payload.event : null;
}

function extractNamespace(payload: OblienWebhookPayload): string | null {
  if (typeof payload.namespace === "string") return payload.namespace;
  if (typeof payload.data?.namespace === "string") return payload.data.namespace;
  return null;
}

/* ───────── Org resolution by namespace ──────────────────────────────────── */

/**
 * Resolve the org id that owns a given Oblien namespace. Returns null
 * when the namespace isn't claimed yet (race against provisioning) or
 * was decommissioned — caller should log + 2xx so Oblien stops retrying
 * a webhook that has no destination.
 */
async function findOrgByNamespace(namespace: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.oblienNamespace, namespace))
    .limit(1);
  return row?.id ?? null;
}

/* ───────── Notification helpers ─────────────────────────────────────────── */

/**
 * Email the org owner (falling back to the first member) with a
 * usage-threshold warning. Failure to send is logged but never throws —
 * notifications are best-effort, the same posture as the past-due path
 * in billing.webhooks.ts.
 */
async function notifyCreditsLow(
  orgId: string,
  usedPercent: number | null,
): Promise<void> {
  try {
    const { repos } = await import("@repo/db");
    const members = await repos.member.listByOrganization(orgId);
    const owner = members.find((m) => m.role === "owner") ?? members[0];
    if (!owner?.user?.email) return;

    const pct = usedPercent != null ? Math.round(usedPercent) : 80;
    await sendMail({
      to: owner.user.email,
      subject: `You've used ${pct}% of this period's credits`,
      html: `
        <p>Hi ${owner.user.name ?? "there"},</p>
        <p>Your workspace has used <strong>${pct}%</strong> of this period's credit allowance.</p>
        <p>To avoid interruption when the cap is reached, you can top up or upgrade your plan at any time from the billing page.</p>
        <p>— Openship</p>
      `,
      text: `Your workspace has used ${pct}% of this period's credit allowance. Top up or upgrade from the billing page to avoid interruption.`,
      organizationId: orgId,
    });
  } catch (err) {
    console.warn(
      `[oblien-webhook] notifyCreditsLow failed for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }
}

/* ───────── Per-event handlers ───────────────────────────────────────────── */

async function handleCreditsDepleted(orgId: string): Promise<void> {
  await quotaWrapper.suspendIfExhausted(orgId);
}

async function handleCreditsLow(
  orgId: string,
  payload: OblienWebhookPayload,
): Promise<void> {
  const usedPercent =
    typeof payload.data?.used_percent === "number"
      ? payload.data.used_percent
      : typeof payload.data?.threshold_percent === "number"
        ? payload.data.threshold_percent
        : null;
  await notifyCreditsLow(orgId, usedPercent);
}

/* ───────── Public Hono handler ──────────────────────────────────────────── */

/**
 * Hono handler for POST /api/billing/oblien-webhook.
 *
 * Mounted via `r.public(...)` so the user-auth middleware is bypassed —
 * authentication here is the HMAC signature, not a session token. The
 * handler ALWAYS reads the raw body first (signature input), then
 * parses the JSON itself; never call `c.req.json()` before
 * verification.
 */
export async function oblienWebhook(c: Context) {
  const signature = c.req.header("x-webhook-signature");
  const rawBody = await c.req.text();

  if (!verifySignature(rawBody, signature)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  let payload: OblienWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as OblienWebhookPayload;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const eventId = extractEventId(payload);
  const eventType = extractEventType(payload);
  const namespace = extractNamespace(payload);

  if (!eventId || !eventType) {
    return c.json({ error: "missing event_id or event" }, 400);
  }

  // Idempotency short-circuit. Returning 2xx here mirrors the Stripe
  // dedupe path — Oblien stops retrying once we acknowledge.
  if (alreadyProcessed(eventId)) {
    return c.json({ received: true, deduped: true });
  }

  // Unknown / unrouted event types: accept silently so Oblien stops
  // retrying. We log so an unexpected event surface in the dashboard
  // gets noticed without throwing operators a 5xx alert.
  const ROUTED = new Set<string>([
    "credits.depleted",
    "credits.low",
    "namespace.quota.threshold",
  ]);
  if (!ROUTED.has(eventType)) {
    console.warn(
      `[oblien-webhook] received unrouted event ${eventType} (id=${eventId}) — accepting without action`,
    );
    markProcessed(eventId);
    return c.json({ received: true });
  }

  if (!namespace) {
    console.warn(
      `[oblien-webhook] event ${eventId} (${eventType}) has no namespace — accepting without action`,
    );
    markProcessed(eventId);
    return c.json({ received: true });
  }

  const orgId = await findOrgByNamespace(namespace);
  if (!orgId) {
    // Namespace not claimed (race against provisioning, or
    // decommissioned). 2xx so Oblien gives up the retry rather than
    // pummeling us indefinitely.
    console.warn(
      `[oblien-webhook] event ${eventId} (${eventType}) namespace=${namespace} has no matching org`,
    );
    markProcessed(eventId);
    return c.json({ received: true });
  }

  try {
    switch (eventType) {
      case "credits.depleted":
        await handleCreditsDepleted(orgId);
        break;
      case "credits.low":
      case "namespace.quota.threshold":
        await handleCreditsLow(orgId, payload);
        break;
    }
    markProcessed(eventId);
    return c.json({ received: true });
  } catch (err) {
    // Do NOT mark processed — let Oblien retry. Bubble a 5xx so the
    // retry budget kicks in and we surface the failure in logs.
    console.error(
      `[oblien-webhook] handler failed for ${eventType} (id=${eventId}, org=${orgId}): ${safeErrorMessage(err)}`,
    );
    throw err;
  }
}
