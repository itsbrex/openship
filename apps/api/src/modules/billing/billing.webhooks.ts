/**
 * Stripe webhook event router for cloud billing.
 *
 * Single entry point — `handleStripeEvent(rawBody, signature)`:
 *
 *   1. Verifies the Stripe signature against STRIPE_WEBHOOK_SECRET. A
 *      malformed/forged payload throws before any DB or Oblien write.
 *   2. Checks `stripe_webhook_event` for an existing row with
 *      `processed_at IS NOT NULL` — if found, returns silently (already
 *      fully processed).
 *   3. Claims the slot via INSERT ... ON CONFLICT DO NOTHING. A conflict
 *      with an unprocessed row means a concurrent retry or a stale crash
 *      claim — either way safe to proceed (handlers are internally
 *      idempotent and the final UPDATE collapses races).
 *   4. Dispatches to a per-type handler. Each handler translates the
 *      event into Oblien quota calls (`setQuota` / `resetQuota` /
 *      `activate`) — Oblien is the single source of truth for credit
 *      allowance + consumption. Local DB writes are limited to the
 *      subscription mapping rows the dashboard / portal need.
 *   5. On success: stamps `processed_at` so the next delivery
 *      short-circuits at step 2.
 *   6. On throw: DELETEs the unprocessed claim so Stripe's redelivery can
 *      retry from scratch, then re-throws so Hono's onError returns 5xx
 *      (Stripe retries on any non-2xx for the first 3 days).
 *
 * Quota-as-allowance model:
 *   - Tier purchase / renewal → `setQuota({quotaLimit: tier.monthlyCredits})`
 *     overwrites the ceiling. Oblien preserves `quota_used` independently
 *     so swapping the ceiling mid-period is correct (clamps high or low).
 *   - Top-up pack → `setQuota({quotaLimit: current + pack.credits})` — read
 *     the current ceiling via `getDetails`, add the pack on top.
 *   - Tier downgrade / cancellation → `setQuotaForTier(orgId, 'free')`.
 *     Oblien clamps any over-consumed amount against the new ceiling.
 *   - Recurring renewal (`invoice.paid`) → `resetQuota` zeroes `quota_used`,
 *     then `setQuota` confirms the tier ceiling for the new period. Both
 *     calls are idempotent.
 *
 * Self-hosted instances never instantiate this — billing.controller only
 * mounts the webhook route under CLOUD_MODE.
 */

import Stripe from "stripe";
import {
  AppError,
  PLANS,
  CREDIT_PACKS,
  safeErrorMessage,
  type PlanTierId,
} from "@repo/core";
import { db, schema, repos, eq, and, isNull, sql } from "@repo/db";
import { env } from "../../config/env";
import { sendMail } from "../../lib/mail";
import {
  upsertSubscription,
  upsertCustomer,
} from "./billing.repository";
import {
  setQuotaForTier,
  addQuota,
  resetAndRegrant,
} from "./billing-oblien-quota";

/* ───────── Stripe client (lazy) ─────────────────────────────────────────── */

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
    }
    _stripe = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

/* ───────── Event type allowlist ─────────────────────────────────────────── */

/**
 * Every event type wired to a concrete handler. Anything not in this set
 * is either rejected (5xx → Stripe retries) when financially relevant, or
 * silently accepted otherwise. The list mirrors the cases in the
 * dispatcher below — keep them in sync.
 */
export const HANDLED_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.deleted",
]);

/**
 * Financial events. If a type lands here but is NOT in HANDLED_EVENT_TYPES
 * we throw a 501 so Stripe retries — silently 2xx-ing a stub would lose
 * subscription state forever. Operators must implement the handler or
 * explicitly opt out via BILLING_WEBHOOK_DISCARD_UNHANDLED=true.
 */
const FINANCIAL_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/* ───────── Public entry point ───────────────────────────────────────────── */

/**
 * Stripe webhook handler. Verifies signature, deduplicates by event.id,
 * dispatches to the per-type handler.
 *
 * Throws on:
 *   - missing/invalid signature
 *   - financially-relevant event types without a handler
 *     (set BILLING_WEBHOOK_DISCARD_UNHANDLED=true to accept-and-drop)
 *   - downstream handler errors (so Stripe retries)
 *
 * Returns silently on:
 *   - duplicate delivery (PK conflict in stripe_webhook_event)
 *   - non-financial unhandled types
 */
export async function handleStripeEvent(
  rawBody: string,
  signature?: string,
): Promise<void> {
  const stripe = getStripe();

  if (!env.STRIPE_WEBHOOK_SECRET || !signature) {
    throw new Error("Webhook signature verification failed");
  }

  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );

  // Idempotency lifecycle, two phases:
  //
  //   "received" = row exists, processed_at = null
  //   "processed" = row exists, processed_at = <timestamp>
  //
  // 1. If the event is already fully processed → silent 2xx (skip).
  // 2. Otherwise claim the slot via INSERT ON CONFLICT DO NOTHING. A
  //    conflict here means another worker is mid-flight OR a prior crash
  //    left a stale "received" row. Either way we proceed — handlers are
  //    internally idempotent and the final UPDATE collapses concurrent
  //    runs into a single processed_at write.
  // 3. Handler runs (below).
  // 4. On success: stamp processed_at so the next delivery short-circuits
  //    at step 1.
  // 5. On throw: DELETE our (unprocessed) claim so Stripe's redelivery can
  //    fully retry from scratch. Without this, the dedupe row from a
  //    failed mid-handler crash blocks Stripe forever even though Oblien
  //    quota state may be half-applied (e.g. sub row written but
  //    namespaces.setQuota 5xx'd before stamping).
  const [alreadyProcessed] = await db
    .select({ stripeEventId: schema.stripeWebhookEvent.stripeEventId })
    .from(schema.stripeWebhookEvent)
    .where(
      and(
        eq(schema.stripeWebhookEvent.stripeEventId, event.id),
        sql`${schema.stripeWebhookEvent.processedAt} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (alreadyProcessed) {
    return;
  }

  await db
    .insert(schema.stripeWebhookEvent)
    .values({
      stripeEventId: event.id,
      eventType: event.type,
    })
    .onConflictDoNothing({ target: schema.stripeWebhookEvent.stripeEventId });

  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    if (FINANCIAL_EVENT_TYPES.has(event.type)) {
      if (process.env.BILLING_WEBHOOK_DISCARD_UNHANDLED === "true") {
        console.warn(
          `[billing] discarding unhandled financial event ${event.id} (${event.type}) — BILLING_WEBHOOK_DISCARD_UNHANDLED=true`,
        );
        await markProcessed(event.id);
        return;
      }
      // Stripe must retry — clear our claim so the redelivery isn't dedupe'd
      // out, then bubble a 5xx via Hono's onError.
      await clearUnprocessedClaim(event.id);
      throw new AppError(
        `Billing webhook handler for ${event.type} is not implemented. Stripe will retry. ` +
          `Set BILLING_WEBHOOK_DISCARD_UNHANDLED=true to accept-and-drop in pre-launch environments.`,
        501,
        "BILLING_WEBHOOK_UNIMPLEMENTED",
      );
    }
    // Non-financial unhandled event (e.g. customer.created notification) — accept.
    await markProcessed(event.id);
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session,
        );
        break;
      case "customer.subscription.created":
        await handleSubscriptionCreated(
          event.data.object as Stripe.Subscription,
        );
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        );
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        );
        break;
      case "invoice.paid":
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case "customer.deleted":
        await handleCustomerDeleted(event.data.object as Stripe.Customer);
        break;
    }
    await markProcessed(event.id);
  } catch (err) {
    // Clear our (unprocessed) claim so Stripe's redelivery can fully retry.
    await clearUnprocessedClaim(event.id);
    console.error(
      `[billing] webhook handler failed for ${event.type} (${event.id}):`,
      safeErrorMessage(err),
    );
    // Re-throw so Hono's onError returns 5xx and Stripe retries.
    throw err;
  }
}

async function markProcessed(eventId: string): Promise<void> {
  await db
    .update(schema.stripeWebhookEvent)
    .set({ processedAt: new Date() })
    .where(eq(schema.stripeWebhookEvent.stripeEventId, eventId));
}

/**
 * Delete our (unprocessed) webhook claim so Stripe's redelivery can fully
 * retry from scratch. Guarded by processed_at IS NULL so a concurrent
 * worker that already succeeded isn't undone. Delete failure is logged but
 * doesn't mask the original handler error — the worst case is Stripe gets
 * one extra silent-success and the user has to re-trigger the action.
 */
async function clearUnprocessedClaim(eventId: string): Promise<void> {
  try {
    await db
      .delete(schema.stripeWebhookEvent)
      .where(
        and(
          eq(schema.stripeWebhookEvent.stripeEventId, eventId),
          isNull(schema.stripeWebhookEvent.processedAt),
        ),
      );
  } catch (delErr) {
    console.error(
      `[billing] failed to clear unprocessed webhook claim for ${eventId}:`,
      safeErrorMessage(delErr),
    );
  }
}

/* ───────── checkout.session.completed ───────────────────────────────────── */

/**
 * Branch on session.mode:
 *   - "subscription" → tier upgrade: upsert subscription mapping (which also
 *     bumps org.planTierId + subscription_status), then `setQuotaForTier`
 *     to overwrite the Oblien quota ceiling with the tier's monthlyCredits.
 *     If the org was credit_exhausted (Oblien suspended), `activate` lifts
 *     the gate so the new allowance is usable.
 *   - "payment"      → one-shot top-up: resolve pack by metadata.packId,
 *     `addQuota` reads the current Oblien ceiling and bumps it by the
 *     pack's credit amount. If suspended, activate.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const orgId =
    session.metadata?.organizationId ??
    (session.client_reference_id || null);
  if (!orgId) {
    console.warn(
      `[billing] checkout.session.completed ${session.id} has no organizationId — skipping`,
    );
    return;
  }

  if (session.mode === "subscription") {
    const planTierId = (session.metadata?.planTierId ??
      session.metadata?.planId ??
      "free") as PlanTierId;
    const plan = PLANS[planTierId];
    if (!plan) {
      throw new AppError(
        `Unknown planTierId in checkout metadata: ${planTierId}`,
        400,
        "BILLING_UNKNOWN_PLAN",
      );
    }

    const stripeSubscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;
    const stripeCustomerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;

    if (!stripeSubscriptionId || !stripeCustomerId) {
      throw new AppError(
        `checkout.session.completed missing subscription/customer ids (${session.id})`,
        400,
        "BILLING_INVALID_CHECKOUT_SESSION",
      );
    }

    // Pull the fresh subscription so we have authoritative period dates +
    // price_id (the session object's expansions vary by API version).
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);

    // Customer mapping table — keeps subsequent webhooks attributable when
    // they only carry customer_id (no metadata).
    await upsertCustomer({
      orgId,
      stripeCustomerId,
      email: session.customer_details?.email ?? session.customer_email ?? "",
    });

    await upsertSubscription({
      organizationId: orgId,
      stripeSubscriptionId,
      stripePriceId: resolvePriceIdFromSub(sub),
      planTierId,
      interval: resolveIntervalFromSub(sub),
      status: sub.status,
      currentPeriodStart: periodStart(sub),
      currentPeriodEnd: periodEnd(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    });

    // Mirror customer id onto the org row for fast lookup (organization
    // already gets planTierId + status from upsertSubscription).
    await db
      .update(schema.organization)
      .set({ stripeCustomerId })
      .where(eq(schema.organization.id, orgId));

    await setQuotaForTier(orgId, planTierId);
    return;
  }

  if (session.mode === "payment") {
    const packId = session.metadata?.packId;
    if (!packId) {
      throw new AppError(
        `payment-mode checkout ${session.id} missing metadata.packId`,
        400,
        "BILLING_MISSING_PACK_ID",
      );
    }
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      throw new AppError(
        `Unknown credit pack: ${packId}`,
        400,
        "BILLING_UNKNOWN_PACK",
      );
    }

    // Pack credits live in milli-credits. The shared wrapper in
    // billing-oblien-quota.ts (also used by the anniversary cron and
    // billing-hardcap) writes Oblien quotas in the same units as
    // PLANS[].monthlyCredits (milli), so we forward the pack's
    // credits_milli directly — no conversion.
    await addQuota(orgId, pack.credits_milli);
    return;
  }

  // Other modes (setup, etc.) — no financial mutation.
}

/* ───────── customer.subscription.created ────────────────────────────────── */

/**
 * Initial subscription record. checkout.session.completed normally lands
 * first and does the heavy lifting; this handler is a safety net for
 * direct-API-created subscriptions (admin tooling, migrations) and is
 * fully idempotent against the checkout flow via upsertSubscription's
 * ON CONFLICT DO UPDATE and Oblien's idempotent setQuota.
 */
async function handleSubscriptionCreated(sub: Stripe.Subscription): Promise<void> {
  const orgId = await resolveOrgFromSubscription(sub);
  if (!orgId) {
    console.warn(
      `[billing] subscription.created ${sub.id} unattributable — skipping`,
    );
    return;
  }
  const planTierId = resolvePlanFromPriceId(sub);

  await upsertSubscription({
    organizationId: orgId,
    stripeSubscriptionId: sub.id,
    stripePriceId: resolvePriceIdFromSub(sub),
    planTierId,
    interval: resolveIntervalFromSub(sub),
    status: sub.status,
    currentPeriodStart: periodStart(sub),
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  });

  await setQuotaForTier(orgId, planTierId);
}

/* ───────── customer.subscription.updated ────────────────────────────────── */

/**
 * Two distinct flows:
 *   1. Price changed → tier change. Overwrite the Oblien quota ceiling
 *      with the new tier's monthlyCredits via `setQuotaForTier`. No manual
 *      proration: Oblien preserves `quota_used` independently per
 *      (namespace, service) so swapping the ceiling mid-period is correct
 *      whether the new tier is higher (more room) or lower (clamped down).
 *   2. cancel_at_period_end flipped → mirror onto the local subscription
 *      row so the dashboard reflects the pending cancellation. No quota
 *      call — the user still has the period they paid for.
 */
async function handleSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const orgId = await resolveOrgFromSubscription(sub);
  if (!orgId) {
    console.warn(
      `[billing] subscription.updated ${sub.id} unattributable — skipping`,
    );
    return;
  }

  const newPlanTierId = resolvePlanFromPriceId(sub);

  // Pull the previous local row to detect price flip vs cancel_at flip.
  const [prev] = await db
    .select()
    .from(schema.billingSubscription)
    .where(eq(schema.billingSubscription.stripeSubscriptionId, sub.id))
    .limit(1);

  const newPriceId = resolvePriceIdFromSub(sub);
  const priceChanged = !!prev && prev.stripePriceId !== newPriceId;

  await upsertSubscription({
    organizationId: orgId,
    stripeSubscriptionId: sub.id,
    stripePriceId: newPriceId,
    planTierId: newPlanTierId,
    interval: resolveIntervalFromSub(sub),
    status: sub.status,
    currentPeriodStart: periodStart(sub),
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  });

  if (priceChanged) {
    // Tier change: Oblien preserves quota_used, so a single setQuota with
    // the new ceiling is correct — no proration, no delta computation.
    await setQuotaForTier(orgId, newPlanTierId);
  }
  // cancel_at_period_end change is already mirrored by upsertSubscription;
  // no Oblien call needed — the current period's allowance stands.
}

/* ───────── customer.subscription.deleted ────────────────────────────────── */

/**
 * Subscription fully ended (cancellation reached period_end, or hard-deleted).
 * Downgrade org to free and set the Free tier ceiling. Oblien preserves
 * the existing quota_used count — if the user over-consumed before the
 * downgrade, the new (lower) ceiling will naturally enforce that.
 *
 * No need to "expire" credits — Oblien holds the consumption count, not a
 * minted-credit ledger. There's nothing to clear.
 */
async function handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const orgId = await resolveOrgFromSubscription(sub);
  if (!orgId) {
    console.warn(
      `[billing] subscription.deleted ${sub.id} unattributable — skipping`,
    );
    return;
  }

  await upsertSubscription({
    organizationId: orgId,
    stripeSubscriptionId: sub.id,
    stripePriceId: resolvePriceIdFromSub(sub),
    planTierId: "free",
    interval: resolveIntervalFromSub(sub),
    status: "canceled",
    currentPeriodStart: periodStart(sub),
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: false,
  });

  await setQuotaForTier(orgId, "free");
}

/* ───────── invoice.paid ─────────────────────────────────────────────────── */

/**
 * Period anniversary for a recurring subscription. Two things happen on
 * Oblien:
 *   1. `resetQuota` — zero `quota_used` for (namespace, compute) so the
 *      new period starts at 0.
 *   2. `setQuota` — reaffirm the tier's monthlyCredits ceiling. Redundant
 *      when the tier hasn't changed, but cheap and keeps the renewal
 *      path symmetric with the upgrade path.
 *
 * Both calls are idempotent on Oblien's side, and we also share the period
 * anchor (org, period_start) with the anniversary cron — whichever fires
 * first wins. The initial invoice (`subscription_create`) is skipped here
 * because checkout.session.completed already set the quota; resetting on
 * the first day would zero a counter that's already zero, harmless but
 * noisy.
 *
 * One-shot pack invoices land here too with no subscription id; we skip
 * them — `checkout.session.completed` mode=payment already credited them.
 */
async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  // Invoice objects may carry subscription as id or expanded. Be defensive.
  const subRef = (invoice as unknown as { subscription?: string | { id: string } })
    .subscription;
  const stripeSubscriptionId =
    typeof subRef === "string" ? subRef : subRef?.id ?? null;
  if (!stripeSubscriptionId) {
    // Pack purchases come through as one-off invoices with no subscription;
    // they're credited via checkout.session.completed. Nothing to do here.
    return;
  }

  if (invoice.billing_reason === "subscription_create") {
    // Initial invoice — checkout.session.completed already set the quota.
    return;
  }

  // Look up local sub to attribute org + tier.
  const [localSub] = await db
    .select()
    .from(schema.billingSubscription)
    .where(eq(schema.billingSubscription.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  if (!localSub) {
    console.warn(
      `[billing] invoice.paid ${invoice.id} references unknown subscription ${stripeSubscriptionId}`,
    );
    return;
  }

  // Pull the live subscription to get the new period boundaries (the invoice
  // close usually advances current_period_*).
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const planTierId = localSub.planTierId as PlanTierId;

  await upsertSubscription({
    organizationId: localSub.organizationId,
    stripeSubscriptionId: sub.id,
    stripePriceId: resolvePriceIdFromSub(sub),
    planTierId,
    interval: resolveIntervalFromSub(sub),
    status: sub.status,
    currentPeriodStart: periodStart(sub),
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  });

  await resetAndRegrant(localSub.organizationId, planTierId);
}

/* ───────── invoice.payment_failed ───────────────────────────────────────── */

/**
 * Stripe couldn't pull the card. Flip the org into past_due so the
 * dashboard banner + middleware messaging surface the problem, and email
 * the org owner so they can update payment before Stripe's dunning runs
 * out.
 *
 * Critically: NO Oblien call here. Payment failure is a billing UX state,
 * not a quota state — the user still has whatever allowance they had a
 * second ago. Suspending the namespace on every transient card decline
 * would punish customers for issuer-side flakiness. The hard-cap path
 * (driven by Oblien's `credits.depleted` webhook into namespaces.suspend)
 * is the only thing that should stop workloads.
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const subRef = (invoice as unknown as { subscription?: string | { id: string } })
    .subscription;
  const stripeSubscriptionId =
    typeof subRef === "string" ? subRef : subRef?.id ?? null;
  if (!stripeSubscriptionId) return;

  const [localSub] = await db
    .select()
    .from(schema.billingSubscription)
    .where(eq(schema.billingSubscription.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  if (!localSub) return;

  await db
    .update(schema.organization)
    .set({ subscriptionStatus: "past_due" })
    .where(eq(schema.organization.id, localSub.organizationId));

  // Notify the org owner. Failure to send isn't fatal — the dashboard banner
  // is the real signal, mail is best-effort.
  await notifyPastDue(localSub.organizationId, invoice).catch((err) =>
    console.warn(
      "[billing] past_due notification send failed:",
      safeErrorMessage(err),
    ),
  );
}

/* ───────── customer.deleted ─────────────────────────────────────────────── */

/**
 * The Stripe customer was hard-deleted (admin tooling, GDPR erasure, etc.).
 * Null out the local stripe_customer_id pointer so re-subscribes mint a
 * fresh customer instead of trying to use the dead id. The Oblien
 * namespace is left untouched — a deleted Stripe customer doesn't mean
 * the org is gone, and historical usage rows on Oblien still need a home.
 */
async function handleCustomerDeleted(customer: Stripe.Customer): Promise<void> {
  await db
    .update(schema.organization)
    .set({ stripeCustomerId: null })
    .where(eq(schema.organization.stripeCustomerId, customer.id));

  await db
    .update(schema.billingCustomer)
    .set({ updatedAt: new Date() })
    .where(eq(schema.billingCustomer.stripeCustomerId, customer.id));
}

/* ───────── Helpers ──────────────────────────────────────────────────────── */

function resolvePriceIdFromSub(sub: Stripe.Subscription): string {
  // First subscription item drives the tier — we never sell multi-item subs.
  const item = sub.items?.data?.[0];
  return item?.price?.id ?? "";
}

function resolveIntervalFromSub(sub: Stripe.Subscription): "monthly" | "annual" {
  const item = sub.items?.data?.[0];
  const recurring = item?.price?.recurring;
  if (recurring?.interval === "year") return "annual";
  return "monthly";
}

function resolvePlanFromPriceId(sub: Stripe.Subscription): PlanTierId {
  const priceId = resolvePriceIdFromSub(sub);
  for (const tier of ["pro", "team", "enterprise"] as const) {
    const plan = PLANS[tier];
    if (
      plan.stripePriceId.monthly === priceId ||
      plan.stripePriceId.annual === priceId
    ) {
      return tier;
    }
  }
  return "free";
}

async function resolveOrgFromSubscription(
  sub: Stripe.Subscription,
): Promise<string | null> {
  // Prefer the metadata fast-path (set at checkout time).
  const metaOrg = sub.metadata?.organizationId;
  if (metaOrg) return metaOrg;

  // Fall back to the customer mapping table.
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const [row] = await db
    .select({ organizationId: schema.billingCustomer.organizationId })
    .from(schema.billingCustomer)
    .where(eq(schema.billingCustomer.stripeCustomerId, customerId))
    .limit(1);
  return row?.organizationId ?? null;
}

function periodStart(sub: Stripe.Subscription): Date {
  // Stripe types vary by API version on whether period dates live on the
  // subscription or the first item — read the subscription-level fields,
  // they're populated on every API version that supports webhooks.
  const raw = (sub as unknown as { current_period_start?: number })
    .current_period_start;
  return raw ? new Date(raw * 1000) : new Date();
}

function periodEnd(sub: Stripe.Subscription): Date {
  const raw = (sub as unknown as { current_period_end?: number })
    .current_period_end;
  return raw ? new Date(raw * 1000) : new Date();
}

/* ───────── Past-due notification ────────────────────────────────────────── */

async function notifyPastDue(
  organizationId: string,
  invoice: Stripe.Invoice,
): Promise<void> {
  const members = await repos.member.listByOrganization(organizationId);
  const owner = members.find((m) => m.role === "owner") ?? members[0];
  if (!owner?.user?.email) return;

  const amount = ((invoice.amount_due ?? 0) / 100).toFixed(2);
  const hostedInvoiceUrl = invoice.hosted_invoice_url ?? "";
  await sendMail({
    to: owner.user.email,
    subject: "Action required: payment failed",
    html: `
      <p>Hi ${owner.user.name ?? "there"},</p>
      <p>We weren't able to charge your card for invoice <strong>${invoice.number ?? invoice.id}</strong> (${amount} ${(invoice.currency ?? "usd").toUpperCase()}).</p>
      <p>Your workspace is now in <strong>past_due</strong> — please update your payment method to restore full access.</p>
      ${hostedInvoiceUrl ? `<p><a href="${hostedInvoiceUrl}">Update payment method</a></p>` : ""}
      <p>— Openship</p>
    `,
    text: `We weren't able to charge your card for invoice ${invoice.number ?? invoice.id} (${amount}). Update payment to restore access: ${hostedInvoiceUrl}`,
    organizationId,
  });
}
