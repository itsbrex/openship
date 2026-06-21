/**
 * Hard-cap handler — flips an organization's Oblien namespace between
 * suspended and active based on its credit balance.
 *
 * Triggered by the credit-metering worker when the usage rollup drives
 * an org's balance to <= 0 (suspend) or when a top-up / subscription
 * renewal restores balance (activate). Idempotent on both sides:
 *
 *   - `handleCreditExhausted` short-circuits when the org is already
 *     in `credit_exhausted`. The Oblien `suspend` call is itself
 *     idempotent server-side, but we still gate locally so we don't
 *     spam audit + notification rows on every metering tick.
 *
 *   - `restoreOblienLimits` short-circuits when the org is already
 *     `active`. It re-applies the tier's resource_limits on every
 *     restore so a recently bumped plan picks up its new ceilings
 *     even if the org never crossed the cap.
 *
 * Both handlers run server-side under CLOUD_MODE. They use the master
 * Oblien client (getOblienClient) — the per-org namespace-scoped token
 * cannot suspend its own namespace.
 *
 * Errors are surfaced to the caller (the worker) so retries are
 * possible; partial-progress is acceptable — DB row + Oblien state are
 * eventually consistent, both checked on every invocation.
 */

import { PLANS, type PlanTierId, safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";

import { audit } from "../../lib/audit";
import { notification } from "../../lib/notification-dispatcher";
import { getOblienClient } from "../../lib/openship-cloud";

const ACTIVE_STATUS = "active";
const EXHAUSTED_STATUS = "credit_exhausted";

/**
 * Map an arbitrary string column value to a known PlanTierId. Falls
 * back to `free` for unknown values — better to apply the most
 * conservative ceilings than to crash the restore path on a bad row.
 */
function resolvePlanTier(planTierId: string | null | undefined): PlanTierId {
  switch (planTierId) {
    case "free":
    case "pro":
    case "team":
    case "enterprise":
      return planTierId;
    default:
      return "free";
  }
}

/**
 * Suspend the org's Oblien namespace and mark the org's subscription
 * status as `credit_exhausted`. Safe to call repeatedly — short-circuits
 * when the org is already in the target state.
 */
export async function handleCreditExhausted(orgId: string): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`handleCreditExhausted: organization ${orgId} not found`);
  }

  // Idempotency gate: if we've already flipped this org to exhausted,
  // there's nothing left to do. Avoids spurious audit + notification
  // rows on every metering tick while the org stays over the cap.
  if (org.subscriptionStatus === EXHAUSTED_STATUS) {
    return;
  }

  if (!org.oblienNamespace) {
    // No namespace provisioned yet — nothing to suspend on Oblien's
    // side. Still flip the local status so middleware gating engages,
    // and emit the audit/notification so the org sees they hit the cap.
    await repos.organization.setSubscriptionStatus(orgId, EXHAUSTED_STATUS);
  } else {
    const client = getOblienClient();
    try {
      await client.namespaces.suspend(org.oblienNamespace);
    } catch (err) {
      throw new Error(
        `Failed to suspend Oblien namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
      );
    }
    await repos.organization.setSubscriptionStatus(orgId, EXHAUSTED_STATUS);
  }

  await audit.record(
    { organizationId: orgId, actorUserId: null },
    {
      eventType: "billing.credit_exhausted",
      resourceType: "organization",
      resourceId: orgId,
      before: { subscriptionStatus: org.subscriptionStatus },
      after: {
        subscriptionStatus: EXHAUSTED_STATUS,
        oblienNamespace: org.oblienNamespace ?? null,
      },
    },
  );

  notification.emit({
    organizationId: orgId,
    eventType: "billing.credit_exhausted",
    resourceType: "organization",
    resourceId: orgId,
    payload: {
      planTierId: org.planTierId,
      oblienNamespace: org.oblienNamespace ?? null,
    },
  });
}

/**
 * Re-activate the org's Oblien namespace and re-apply the per-tier
 * `oblien_limits` ceiling. Safe to call repeatedly — short-circuits when
 * already active, and re-applies limits idempotently on every restore so
 * a recent plan bump picks up new ceilings on the next renewal/top-up.
 */
export async function restoreOblienLimits(orgId: string): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`restoreOblienLimits: organization ${orgId} not found`);
  }

  // Idempotency gate: if the org is already active, no transition to
  // record. We still want to re-apply resource_limits on plan bumps,
  // but that's handled by a dedicated plan-change path — the restore
  // handler's contract is "bring an exhausted org back up".
  if (org.subscriptionStatus === ACTIVE_STATUS) {
    return;
  }

  const tier = PLANS[resolvePlanTier(org.planTierId)];

  if (org.oblienNamespace) {
    const client = getOblienClient();
    try {
      await client.namespaces.activate(org.oblienNamespace);
    } catch (err) {
      throw new Error(
        `Failed to activate Oblien namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
      );
    }

    // Re-apply tier ceilings every restore. Enterprise tier has
    // `oblienLimits: null` (custom per contract) — skip the update so
    // we don't overwrite a hand-tuned namespace.
    if (tier.oblienLimits) {
      try {
        await client.namespaces.update(org.oblienNamespace, {
          resource_limits: tier.oblienLimits,
        });
      } catch (err) {
        throw new Error(
          `Failed to apply ${tier.id} resource_limits to namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
        );
      }
    }
  }

  await repos.organization.setSubscriptionStatus(orgId, ACTIVE_STATUS);

  await audit.record(
    { organizationId: orgId, actorUserId: null },
    {
      eventType: "billing.credit_restored",
      resourceType: "organization",
      resourceId: orgId,
      before: { subscriptionStatus: org.subscriptionStatus },
      after: {
        subscriptionStatus: ACTIVE_STATUS,
        planTierId: tier.id,
        oblienNamespace: org.oblienNamespace ?? null,
        oblienLimits: tier.oblienLimits ?? null,
      },
    },
  );
}
