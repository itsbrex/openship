/**
 * Billing anniversary cron — Oblien-quota-resetting rollover.
 *
 * Replaces the legacy `billing-reset.cron` which minted local
 * credit_grant rows. The credit ledger is gone (see migration
 * 0011_remove_credit_ledger); Oblien now owns consumption and quota
 * enforcement. This cron is the openship-side bridge that re-arms each
 * org's Oblien quota at the boundary of every billing period:
 *
 *   1. Pick orgs where current_period_end < now() AND
 *      subscription_status NOT IN ('canceled'). The Stripe webhook is
 *      still the authoritative driver for paid orgs — this cron is the
 *      safety net for orgs whose webhook delivery lagged, plus the only
 *      mechanism for free-tier orgs (no Stripe subscription to fire a
 *      period-end webhook).
 *
 *   2. For each candidate, read the tier from organization.plan_tier_id,
 *      look up the tier definition from PLANS, and call the quota
 *      wrapper:
 *        a. namespaces.resetQuota(...)         → zero out quota_used
 *        b. namespaces.setQuota({ quotaLimit, … }) → re-arm the limit
 *           for the new period with `stop_workspaces` on overdraft.
 *      Both calls are idempotent on Oblien's side, so racing with a
 *      Stripe webhook handler that already ran them is harmless.
 *
 *   3. Advance organization.current_period_start/end by one calendar
 *      month. The advance is the natural idempotency key — once
 *      period_end is in the future, the org is skipped on subsequent
 *      ticks until the next rollover.
 *
 *   4. If the org was in 'credit_exhausted' state, call
 *      namespaces.activate(...) to lift the suspension and flip the
 *      local status to 'active'. The new quota window gives the org
 *      headroom to run again.
 *
 *   5. Emit a `billing.anniversary_reset` audit event with a
 *      before/after diff so operators can trace which orgs the cron
 *      touched.
 *
 * Idempotency: the period-end advance is the marker. If the Stripe
 * webhook beat us (it advances period_end via Stripe's reported
 * timestamps), the candidate query won't pick up the org. The quota
 * SDK calls themselves are also idempotent — setQuota is an
 * upsert-shape, resetQuota is a zero-set.
 *
 * Tier definitions with `monthlyCredits === null` (enterprise) are
 * skipped — those orgs are managed under contract, not the rollover
 * cron.
 *
 * Self-hosted no-op: master Oblien credentials only live on the SaaS
 * API, so the sweep exits early when CLOUD_MODE is false. Period
 * advances depend on Stripe in that path, which is also CLOUD_MODE
 * only — there's nothing for self-hosted to roll over.
 */

import { PLANS, type PlanTierId, safeErrorMessage } from "@repo/core";
import { and, db, eq, lt, notInArray, repos, schema } from "@repo/db";
import { env } from "../../config/env";
import { getJobRunner } from "../../lib/job-runner";
import { getOblienClient } from "../../lib/openship-cloud";

const BILLING_ANNIVERSARY_JOB_ID = "billing:anniversary-reset";
// Hourly at minute 7 — keeps the legacy schedule so booted instances
// don't double-fire while migrating, and stays off the :00/:30 marks
// other jobs use.
const BILLING_ANNIVERSARY_CRON = "7 * * * *";

const SKIP_STATUSES = ["canceled"] as const;

/**
 * Oblien service key the quota applies to. Today every metered
 * resource (compute + edge + storage) rolls up under the single
 * "compute" service. If pricing later splits services, this becomes a
 * loop over per-tier service definitions — the wrapper signature
 * doesn't have to change.
 */
const QUOTA_SERVICE = "compute";

/**
 * Action Oblien takes when an org busts `quotaLimit + overdraft`. We
 * choose `stop_workspaces` (not `block`) so a busted org sees its
 * running workloads halted — matching the credit_exhausted semantics
 * the suspend-side of the hard-cap handler enforces. Block would let
 * existing workspaces keep running until they tried to provision new
 * resources, which is not the contract on the openship side.
 */
const ON_OVERDRAFT_ACTION = "stop_workspaces" as const;

/**
 * Reset + re-arm an org's Oblien quota for a fresh period.
 *
 * Two SDK calls, idempotent server-side, in order:
 *   1. resetQuota → quota_used := 0 (and the period_start/end Oblien
 *      tracks for the quota row is rolled forward).
 *   2. setQuota   → quotaLimit := monthlyCredits, period := monthly,
 *      onOverdraftAction := stop_workspaces. Upsert shape: if the
 *      quota row didn't exist (first ever rollover for this org), this
 *      creates it; if it did, it's a no-op when the values match and
 *      an update when the tier changed under us.
 *
 * Exported as `quotaWrapper.resetAndRegrant` so the Stripe webhook
 * handler can call the same routine when it advances period_end —
 * keeping the two writers' semantics aligned.
 */
export const quotaWrapper = {
  async resetAndRegrant(
    organizationId: string,
    namespace: string,
    quotaLimit: number,
  ): Promise<void> {
    const client = getOblienClient();

    // Reset first — zeroing the counter before we re-arm the limit
    // means a brief window where the org has the new limit and zero
    // usage. The reverse order (set first, then reset) leaves an even
    // briefer window of "old limit, zero usage" which is harmless but
    // semantically weirder.
    await client.namespaces.resetQuota({
      namespace,
      service: QUOTA_SERVICE,
    });

    // Note: the SDK no longer accepts `period` on setQuota — the
    // quota's reset cadence is now driven by resetQuota calls (the
    // openship side owns the period boundary, not Oblien's clock).
    await client.namespaces.setQuota({
      namespace,
      service: QUOTA_SERVICE,
      quotaLimit,
      onOverdraftAction: ON_OVERDRAFT_ACTION,
    });

    void organizationId; // reserved for future per-org metrics
  },
};

/**
 * Lift the credit-exhausted throttle on an org's Oblien namespace.
 *
 * The namespace was previously `suspend`-ed by the hard-cap handler
 * when quota_used crossed the limit. Activating it here re-enables
 * workspace power transitions in Oblien. The local subscription_status
 * flip from `credit_exhausted` → `active` happens in the caller in the
 * same DB write that advances the period.
 *
 * Failures here are surfaced — we'd rather retry the whole rollover
 * next tick than leave a misaligned namespace+org row pair (Oblien
 * suspended, local status active).
 */
async function activateExhaustedNamespace(namespace: string): Promise<void> {
  const client = getOblienClient();
  await client.namespaces.activate(namespace);
}

/**
 * Advance a Date by one calendar month. Handles month-end edge cases
 * (Jan 31 → Feb 28/29) the same way Stripe does — clamp to the last
 * day of the target month.
 */
function addOneMonth(d: Date): Date {
  const next = new Date(d.getTime());
  const originalDay = next.getUTCDate();
  next.setUTCMonth(next.getUTCMonth() + 1);
  // setUTCMonth overshoots when the original day doesn't exist in the
  // target month — e.g. setting Jan 31 → Feb 31 wraps to Mar 3.
  // Detect and clamp.
  if (next.getUTCDate() < originalDay) {
    next.setUTCDate(0); // last day of previous (target) month
  }
  return next;
}

interface ResetStats {
  candidates: number;
  reset: number;
  restored: number;
  skipped: number;
  errors: number;
}

/**
 * Single sweep — find candidate orgs and roll each one's period.
 * Returns aggregate counts for logging. Exported for tests and for
 * a future operator-facing "force-reset" admin endpoint.
 */
export async function runAnniversaryReset(): Promise<ResetStats> {
  const stats: ResetStats = {
    candidates: 0,
    reset: 0,
    restored: 0,
    skipped: 0,
    errors: 0,
  };

  const now = new Date();

  const candidates = await db
    .select({
      id: schema.organization.id,
      planTierId: schema.organization.planTierId,
      subscriptionStatus: schema.organization.subscriptionStatus,
      currentPeriodStart: schema.organization.currentPeriodStart,
      currentPeriodEnd: schema.organization.currentPeriodEnd,
      oblienNamespace: schema.organization.oblienNamespace,
    })
    .from(schema.organization)
    .where(
      and(
        lt(schema.organization.currentPeriodEnd, now),
        notInArray(schema.organization.subscriptionStatus, [...SKIP_STATUSES]),
      ),
    );

  stats.candidates = candidates.length;

  for (const org of candidates) {
    try {
      // The schema column is `text` typed as a free-form string; PLANS
      // is keyed by PlanTierId. Cast + verify the plan exists.
      const tierId = org.planTierId as PlanTierId;
      const tier = PLANS[tierId];
      if (!tier) {
        console.warn(
          `[billing-anniversary] org=${org.id} has unknown plan_tier_id=${org.planTierId} — skipping`,
        );
        stats.skipped += 1;
        continue;
      }

      // Enterprise tier (monthlyCredits === null) is custom — quota is
      // hand-set per contract, not by the rollover cron.
      if (tier.monthlyCredits === null) {
        stats.skipped += 1;
        continue;
      }

      // No Oblien namespace yet → nothing to push quota at. Still
      // advance the period so we don't keep picking the org up; the
      // first provisioning call will set the quota from scratch.
      if (!org.oblienNamespace) {
        const newPeriodStart = org.currentPeriodEnd ?? now;
        const newPeriodEnd = addOneMonth(newPeriodStart);
        await db
          .update(schema.organization)
          .set({
            currentPeriodStart: newPeriodStart,
            currentPeriodEnd: newPeriodEnd,
          })
          .where(eq(schema.organization.id, org.id));
        stats.skipped += 1;
        continue;
      }

      // Compute the next period window. Anchor on currentPeriodEnd if
      // present (preserves Stripe's exact billing-day alignment), else
      // anchor on `now` (first rollover after free-tier signup).
      const newPeriodStart = org.currentPeriodEnd ?? now;
      const newPeriodEnd = addOneMonth(newPeriodStart);

      // 1. Push the quota reset + re-arm to Oblien.
      await quotaWrapper.resetAndRegrant(
        org.id,
        org.oblienNamespace,
        tier.monthlyCredits,
      );

      // 2. Activate the namespace if the org had been suspended for
      //    credit exhaustion. Sequencing matters — re-arming the
      //    quota first means the workspaces don't briefly come up
      //    against the old (busted) limit.
      const wasExhausted = org.subscriptionStatus === "credit_exhausted";
      if (wasExhausted) {
        try {
          await activateExhaustedNamespace(org.oblienNamespace);
          stats.restored += 1;
        } catch (err) {
          // Don't fail the whole rollover if activate races with a
          // manual operator flip — log and keep going. The local
          // status flip below stays gated on a successful activate
          // call by short-circuiting on the catch.
          console.warn(
            `[billing-anniversary] activate failed for ns=${org.oblienNamespace}: ${safeErrorMessage(err)}`,
          );
          // Re-throw so the outer catch tracks it as an error and
          // skips the local subscription_status flip — we don't want
          // to claim active when Oblien still has us suspended.
          throw err;
        }
      }

      // 3. Single UPDATE that advances the period and (when relevant)
      //    flips subscription_status back to active. Atomic — either
      //    both land or neither.
      const newSubscriptionStatus = wasExhausted ? "active" : org.subscriptionStatus;
      await db
        .update(schema.organization)
        .set({
          currentPeriodStart: newPeriodStart,
          currentPeriodEnd: newPeriodEnd,
          subscriptionStatus: newSubscriptionStatus,
        })
        .where(eq(schema.organization.id, org.id));

      // 4. Emit audit event. Fire-and-forget — losing this row is a
      //    forensic gap but doesn't block the next tick. Match the
      //    legacy event_type wrapper shape used by the rest of the
      //    billing module.
      await repos.auditEvent
        .create({
          organizationId: org.id,
          actorUserId: null, // system-emitted
          eventType: "billing.anniversary_reset",
          resourceType: "organization",
          resourceId: org.id,
          ipAddress: null,
          userAgent: null,
          before: {
            planTierId: org.planTierId,
            subscriptionStatus: org.subscriptionStatus,
            currentPeriodStart: org.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
          },
          after: {
            planTierId: org.planTierId,
            subscriptionStatus: newSubscriptionStatus,
            currentPeriodStart: newPeriodStart.toISOString(),
            currentPeriodEnd: newPeriodEnd.toISOString(),
            oblienNamespace: org.oblienNamespace,
            quotaLimit: tier.monthlyCredits,
            quotaService: QUOTA_SERVICE,
            restoredFromExhausted: wasExhausted,
          },
        })
        .catch((err) =>
          console.warn(
            `[billing-anniversary] audit emit failed for org=${org.id}: ${safeErrorMessage(err)}`,
          ),
        );

      stats.reset += 1;
    } catch (err) {
      stats.errors += 1;
      console.error(
        `[billing-anniversary] failed to reset org=${org.id}: ${safeErrorMessage(err)}`,
      );
    }
  }

  return stats;
}

/**
 * Boot-time registration. Idempotent (registering the same jobId
 * replaces). Safe to call unconditionally — exits early on self-hosted
 * since there's no Oblien master client to call quota methods on.
 *
 * Exported under the legacy name `scheduleBillingReset` to keep the
 * boot wiring in app.ts a one-line import swap.
 */
export async function scheduleBillingAnniversary(): Promise<void> {
  if (!env.CLOUD_MODE) {
    // Master Oblien credentials only exist on the SaaS API. The whole
    // anniversary flow is a no-op on self-hosted — period advances
    // come from Stripe (also CLOUD_MODE-only), and there's no quota
    // backend to push to.
    return;
  }

  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: BILLING_ANNIVERSARY_JOB_ID,
    cronExpression: BILLING_ANNIVERSARY_CRON,
    onTick: async () => {
      try {
        const stats = await runAnniversaryReset();
        if (stats.candidates > 0 || stats.errors > 0) {
          console.log(
            `[billing-anniversary] candidates=${stats.candidates} reset=${stats.reset} ` +
              `restored=${stats.restored} skipped=${stats.skipped} errors=${stats.errors}`,
          );
        }
      } catch (err) {
        console.error("[billing-anniversary] sweep failed", err);
      }
    },
  });
}

/**
 * Legacy alias — keep the old import path working through the
 * transition. Callers that already use `scheduleBillingReset` resolve
 * to the new implementation without an import-site edit. Remove once
 * every caller has been migrated.
 */
export const scheduleBillingReset = scheduleBillingAnniversary;
