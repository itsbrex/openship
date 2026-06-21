/**
 * Hard-cap handler — invoked when an org's credit balance hits zero.
 *
 * Currently flips the org's subscription_status to "credit_exhausted"
 * and suspends the Oblien namespace so the meter stops. The hard-cap
 * agent owns the richer policy (grace period, notification fan-out,
 * resume flow); this stub keeps the wiring in place so the Oblien
 * usage sync cron has a defined integration point today.
 *
 * Idempotent: re-invoking on an already-exhausted org is a no-op.
 */

import { db, eq, repos, schema } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { getOblienClient } from "../../lib/openship-cloud";
import { env } from "../../config/env";

export interface ApplyHardCapInput {
  organizationId: string;
  oblienNamespace: string;
  /** Where the trip came from — recorded on the audit event for traceability. */
  reason: string;
}

/**
 * Trip the hard cap for an org. Marks the org credit_exhausted, suspends
 * the Oblien namespace so additional usage stops accruing, and emits an
 * audit event. Safe to call repeatedly — the status flip and the Oblien
 * suspend are both no-ops once already applied.
 */
export async function applyHardCap(input: ApplyHardCapInput): Promise<void> {
  // 1. Read current status so we can short-circuit on re-trips.
  const [org] = await db
    .select({ status: schema.organization.subscriptionStatus })
    .from(schema.organization)
    .where(eq(schema.organization.id, input.organizationId))
    .limit(1);

  const alreadyCapped = org?.status === "credit_exhausted";

  // 2. Flip status (idempotent — same value is fine to re-set).
  if (!alreadyCapped) {
    await db
      .update(schema.organization)
      .set({ subscriptionStatus: "credit_exhausted" })
      .where(eq(schema.organization.id, input.organizationId));
  }

  // 3. Suspend the Oblien namespace so usage stops accruing. Guarded
  //    on CLOUD_MODE — self-hosted instances never reach here (the cron
  //    that calls us is itself CLOUD_MODE-gated) but defense in depth.
  if (env.CLOUD_MODE) {
    try {
      const client = getOblienClient();
      await client.namespaces.suspend(input.oblienNamespace);
    } catch (err) {
      console.warn(
        `[hard-cap] failed to suspend namespace ${input.oblienNamespace}: ${safeErrorMessage(err)}`,
      );
    }
  }

  // 4. Audit trail. Only emit on the first trip to avoid log spam.
  if (!alreadyCapped) {
    await repos.auditEvent
      .create({
        organizationId: input.organizationId,
        actorUserId: null,
        eventType: "billing.hard_cap_tripped",
        resourceType: "billing",
        resourceId: input.organizationId,
        ipAddress: null,
        userAgent: null,
        before: null,
        after: {
          namespace: input.oblienNamespace,
          reason: input.reason,
        },
      })
      .catch((err) =>
        console.warn(
          `[hard-cap] audit emit failed for ${input.organizationId}: ${safeErrorMessage(err)}`,
        ),
      );
  }
}
