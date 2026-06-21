/**
 * Billing controller — Stripe-backed cloud billing endpoints.
 *
 * Every authed route below is org-scoped: the billing customer +
 * subscription rows live on the organization, not the user. The
 * dashboard's active-org context is set by `authMiddleware` and
 * surfaced here via `getActiveOrganizationId`.
 *
 * Stub paths from the early scaffold (manual payment-method/invoice
 * CRUD, free-form usage recording) are NOT re-introduced — Stripe
 * Portal owns the invoice/PM list, and the Oblien usage sync is the
 * only writer to `credit_consumption`. The endpoints below cover what
 * the dashboard actually needs.
 */

import type { Context } from "hono";
import { z } from "zod";
import { PLANS, PLAN_IDS, CREDIT_PACKS } from "@repo/core";
import { getActiveOrganizationId } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import {
  createSubscriptionSchema,
  createTopupSchema,
} from "./billing.schema";
import * as billingService from "./billing.service";
import * as billingRepository from "./billing.repository";
import { getNamespaceUsage } from "./billing-oblien-quota";

/* ---------- Plans (public) ---------- */

/**
 * Surface the static PLANS catalog with the shape the marketing site
 * and signup flow expect. Prices live in cents on the constant and
 * are returned as-is — the client is responsible for formatting.
 */
export async function listPlans(c: Context) {
  const plans = PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return {
      id,
      name: p.name,
      description: p.description,
      popular: p.popular,
      price: p.price, // { monthly: cents|null, annual: cents|null }
      monthlyCredits: p.monthlyCredits,
      oblienLimits: p.oblienLimits,
      features: p.features,
      support: p.support,
      contactSales: p.contactSales ?? null,
    };
  });

  return c.json({ data: { plans } });
}

/* ---------- Billing state (dashboard overview) ---------- */

export async function getState(c: Context) {
  await permission.assert(c, { resourceType: "billing", resourceId: "*", action: "read" });
  const organizationId = getActiveOrganizationId(c);
  const state = await billingService.getBillingState(organizationId);
  return c.json({ data: state });
}

/* ---------- Subscriptions ---------- */

export async function createSubscription(c: Context) {
  await permission.assert(c, { resourceType: "billing", resourceId: "*", action: "write" });
  const organizationId = getActiveOrganizationId(c);
  const user = c.get("user");
  const body = await c.req.json();
  const { planTierId, interval } = createSubscriptionSchema.parse(body);

  const { checkoutUrl } = await billingService.createCheckoutSession(
    organizationId,
    user?.email,
    planTierId,
    interval,
  );

  return c.json({ data: { checkoutUrl } }, 201);
}

export async function cancelSubscription(c: Context) {
  await permission.assert(c, { resourceType: "billing", resourceId: "*", action: "admin" });
  const organizationId = getActiveOrganizationId(c);
  const result = await billingService.cancelSubscription(organizationId);
  return c.json({ data: result });
}

/* ---------- Top-ups ---------- */

export async function createTopup(c: Context) {
  await permission.assert(c, { resourceType: "billing", resourceId: "*", action: "write" });
  const organizationId = getActiveOrganizationId(c);
  const user = c.get("user");
  const body = await c.req.json();
  const { packId } = createTopupSchema.parse(body);

  const { checkoutUrl } = await billingService.createTopupCheckoutSession(
    organizationId,
    user?.email,
    packId,
  );

  return c.json({ data: { checkoutUrl } }, 201);
}

/**
 * Active top-up packs surfaced in the dashboard. Reads from the
 * synced `credit_pack` table; falls back to the in-code `CREDIT_PACKS`
 * constant if the sync hasn't run yet (first-boot bootstrap path).
 */
export async function listTopupPacks(c: Context) {
  await permission.assert(c, { resourceType: "billing", resourceId: "*", action: "read" });
  const packs = await billingService.listActiveCreditPacks();
  if (packs.length > 0) return c.json({ data: packs });
  return c.json({ data: [...CREDIT_PACKS] });
}

/* ---------- Portal ---------- */

export async function createPortal(c: Context) {
  await permission.assert(c, { resourceType: "billing", resourceId: "*", action: "write" });
  const organizationId = getActiveOrganizationId(c);
  const { portalUrl } = await billingService.createPortalSession(organizationId);
  return c.json({ data: { portalUrl } });
}

/* ---------- Raw metered usage (buckets + totals) ---------- */

/**
 * Proxy to Oblien's `namespaces.usageUnits` rollup. Powers the
 * dashboard's usage chart and the credits-spent breakdown.
 *
 * Query params (all optional, ISO8601):
 *   - `from`  default: 30 days ago
 *   - `to`    default: now
 *   - `groupBy` "hour" | "day", default "day"
 *
 * Returns the resolved range echoed back alongside Oblien's payload
 * so the chart doesn't have to re-derive the window when the caller
 * relied on defaults. `usage` is `null` when the org has no namespace
 * yet — the dashboard renders an empty state in that case.
 */
export async function getUsage(c: Context) {
  await permission.assert(c, { resourceType: "billing", resourceId: "*", action: "read" });
  const organizationId = getActiveOrganizationId(c);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");
  const from = fromParam ? new Date(fromParam) : thirtyDaysAgo;
  const to = toParam ? new Date(toParam) : now;

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return c.json({ error: "Invalid `from` or `to` — expected ISO8601" }, 400);
  }

  const groupByParam = c.req.query("groupBy");
  if (groupByParam && groupByParam !== "hour" && groupByParam !== "day") {
    return c.json({ error: "Invalid `groupBy` — expected \"hour\" or \"day\"" }, 400);
  }
  const groupBy: "hour" | "day" = groupByParam === "hour" ? "hour" : "day";

  const usage = await getNamespaceUsage({ organizationId, from, to, groupBy });

  return c.json({
    data: {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy,
      usage,
    },
  });
}

/* ---------- Subscription getter ---------- */

/**
 * Subscription-only sub-slice of the billing state. Kept separate from
 * `getState` so callers (and the local proxy) can poll just the
 * subscription row without re-fetching the credit balance.
 */
export async function getSubscription(c: Context) {
  await permission.assert(c, { resourceType: "billing", resourceId: "*", action: "read" });
  const organizationId = getActiveOrganizationId(c);
  const state = await billingRepository.getBillingState(organizationId);
  return c.json({
    data: {
      tier: state.tier,
      status: state.status,
      currentPeriod: state.currentPeriod,
    },
  });
}

/* ---------- Stripe Webhook ---------- */

export async function stripeWebhook(c: Context) {
  const signature = c.req.header("stripe-signature");
  const rawBody = await c.req.text();
  await billingService.handleStripeEvent(rawBody, signature);
  return c.json({ received: true });
}

// Silence unused-imports — `z` is re-exported only because schemas may
// inline a literal lookup in future iterations, but isn't directly
// referenced at the moment. Drop this guard when the first inline use
// lands.
void z;
