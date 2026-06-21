/**
 * Billing tables — Stripe ↔ Oblien quota bridge.
 *
 * Quota is owned by Oblien (the runtime meters consumption directly and
 * enforces `setQuota` limits). These tables only persist the Stripe-side
 * state needed to compute and push that quota:
 *
 *   stripe webhook → billing_customer / billing_subscription rows updated
 *     → tier change recorded against the org → Oblien `setQuota` call
 *     pushes the new absolute quota for the org's namespace.
 *
 * Tables:
 *   - billing_customer        per-org Stripe customer mapping
 *   - billing_subscription    per-org Stripe subscription history
 *   - credit_pack             catalog of one-shot top-up SKUs
 *   - stripe_webhook_event    idempotency table for Stripe webhook delivery
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── billing_customer ────────────────────────────────────────────────────────
// Per-org Stripe customer mapping. Unique on organization_id — one customer
// per org. Stripe customer id captured + uniqued so a webhook delivered for
// the wrong org can be rejected at the DB layer.

export const billingCustomer = pgTable(
  "billing_customer",
  {
    id: text("id").primaryKey(), // "bc_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_billing_customer_org").on(table.organizationId),
    uniqueIndex("uq_billing_customer_stripe").on(table.stripeCustomerId),
  ],
);

// ─── billing_subscription ────────────────────────────────────────────────────
// Per-org Stripe subscription history. Historical rows are kept (cancellation
// doesn't delete, just updates status), hence the (org_id) index — orgs may
// have multiple rows over time and we routinely query "subs for this org".

export const billingSubscription = pgTable(
  "billing_subscription",
  {
    id: text("id").primaryKey(), // "bs_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    /** 'free' | 'pro' | 'team' | 'enterprise' */
    planTierId: text("plan_tier_id").notNull(),
    /** 'monthly' | 'annual' */
    interval: text("interval").notNull(),
    /** Mirrors Stripe sub.status verbatim. */
    status: text("status").notNull(),
    currentPeriodStart: timestamp("current_period_start").notNull(),
    currentPeriodEnd: timestamp("current_period_end").notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_billing_subscription_stripe").on(table.stripeSubscriptionId),
    index("idx_billing_subscription_org").on(table.organizationId),
  ],
);

// ─── credit_pack ─────────────────────────────────────────────────────────────
// Catalog of one-shot top-up SKUs surfaced in the dashboard. Stripe price id
// is uniqued so the webhook can resolve a checkout-completion event back to
// a row deterministically.

export const creditPack = pgTable(
  "credit_pack",
  {
    id: text("id").primaryKey(), // "cp_..."
    name: text("name").notNull(),
    creditsMilli: bigint("credits_milli", { mode: "number" }).notNull(),
    priceCents: integer("price_cents").notNull(),
    stripeProductId: text("stripe_product_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    uniqueIndex("uq_credit_pack_stripe_price").on(table.stripePriceId),
  ],
);

// ─── stripe_webhook_event ────────────────────────────────────────────────────
// Idempotency table for inbound Stripe webhooks. The id IS the Stripe event
// id, so re-delivery of the same event hits a PK conflict and the handler
// short-circuits. processed_at is set when the handler runs to completion.

export const stripeWebhookEvent = pgTable("stripe_webhook_event", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
});
