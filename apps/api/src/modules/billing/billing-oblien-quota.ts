/**
 * Oblien quota wrapper — single point of contact for credit-related
 * calls against the Oblien `/credits/namespace-quota` API surface.
 *
 * Everything else that needs to talk to Oblien for credits (Stripe
 * webhooks for tier change / topup, the monthly-reset cron, the
 * `credits.depleted` webhook handler, billing controllers) routes
 * through THIS file. Centralising it here means:
 *
 *   - One place owns the `service` code we bill against
 *     (`SERVICE_CODE = "compute"` per Oblien team) so a typo can't
 *     drift between writers and readers.
 *   - The camelCase param shape (`quotaLimit`) vs the snake_case
 *     persisted shape (`quota_limit`) is mapped exactly once.
 *   - Suspend / activate stay in lockstep with the local
 *     `subscription_status` column — webhook callers don't have to
 *     remember to flip both.
 *   - When Oblien renames a field or adds a new param, only this
 *     file touches the SDK.
 *
 * Runs server-side under CLOUD_MODE — `getOblienClient()` refuses to
 * instantiate elsewhere. Every helper short-circuits gracefully when
 * the org's `oblien_namespace` hasn't been provisioned yet (returning
 * null / no-op) so callers don't need an extra guard.
 */

import { PLANS, type PlanTierId, safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { NamespaceUsageUnits } from "@repo/adapters";

import { getOblienClient } from "../../lib/openship-cloud";

/**
 * Canonical credits service code per Oblien team. All quota reads
 * AND writes go through this constant — never inline the literal.
 */
const SERVICE_CODE = "compute";

const ACTIVE_STATUS = "active";
const EXHAUSTED_STATUS = "credit_exhausted";

/**
 * Local mirror of the relevant fields off `NamespaceQuota` (Oblien
 * SDK 2.2.37 `dist/types/namespace.d.ts:149-170`). We deliberately
 * narrow to the three counters callers actually need — callers
 * shouldn't be reading `last_threshold_fired` or `enabled` from this
 * wrapper, those are wire-level concerns.
 *
 * `quotaRemaining` is computed (limit − used) and clamped to 0 so
 * UI doesn't have to repeat the math; null limit (unset on Oblien
 * side) means "unlimited" → returned as Infinity for callers that
 * want a single numeric field to gate on.
 */
export interface QuotaState {
  quotaLimit: number | null;
  quotaUsed: number;
  quotaRemaining: number;
}

/**
 * Shape Oblien returns from `getDetails` for the bits we care about.
 * The SDK's `ApiResponse` declares `[key: string]: unknown` so we
 * narrow defensively here rather than casting blind.
 */
interface OblienQuotaRow {
  service?: string;
  quota_limit?: number | null;
  quota_used?: number | null;
}

interface OblienDetailsResponse {
  data?: {
    quotas?: OblienQuotaRow[];
  };
}

/**
 * Map an arbitrary string column value to a known PlanTierId. Falls
 * back to `free` for unknown values — same conservative posture as
 * billing-hardcap.resolvePlanTier.
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
 * Read the org's compute quota from Oblien. Returns null when the
 * org hasn't been onboarded to a namespace yet (no `oblien_namespace`
 * column), or when Oblien has no quota row for the compute service
 * on this namespace yet.
 */
export async function getQuotaState(orgId: string): Promise<QuotaState | null> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`getQuotaState: organization ${orgId} not found`);
  }
  if (!org.oblienNamespace) return null;

  const client = getOblienClient();
  let res: OblienDetailsResponse;
  try {
    res = (await client.namespaces.getDetails(org.oblienNamespace)) as OblienDetailsResponse;
  } catch (err) {
    throw new Error(
      `Failed to read Oblien quota for namespace ${org.oblienNamespace} (org ${orgId}): ${safeErrorMessage(err)}`,
    );
  }

  const quotas = res?.data?.quotas ?? [];
  const row = quotas.find((q) => q?.service === SERVICE_CODE);
  if (!row) return null;

  const quotaLimit = typeof row.quota_limit === "number" ? row.quota_limit : null;
  const quotaUsed = typeof row.quota_used === "number" ? row.quota_used : 0;
  const quotaRemaining =
    quotaLimit === null ? Number.POSITIVE_INFINITY : Math.max(0, quotaLimit - quotaUsed);

  return { quotaLimit, quotaUsed, quotaRemaining };
}

/**
 * Apply a tier's monthly credit allotment as the compute quota on
 * the org's namespace. Idempotent on Oblien's side — repeated calls
 * just overwrite the same row.
 *
 * Enterprise tiers (`monthlyCredits === null`) are no-ops here: their
 * quota is set out-of-band per contract via admin grants, and we
 * don't want to clobber that with a generic ceiling.
 *
 * No-op when the namespace isn't provisioned yet — callers can run
 * this on plan change without needing to gate on namespace state.
 *
 * Side effect: if the org is currently `credit_exhausted` (Oblien
 * suspended the namespace when usage crossed the prior, lower cap),
 * this implicitly lifts the gate via `restoreFromExhausted`. That
 * keeps tier-upgrade / pack-purchase / renewal call sites from
 * having to remember a separate restore call — the new allowance
 * is immediately usable. `restoreFromExhausted` is idempotent, so
 * orgs already `active` pay only the column read.
 */
export async function setQuotaForTier(orgId: string, tierId: PlanTierId): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`setQuotaForTier: organization ${orgId} not found`);
  }
  if (!org.oblienNamespace) return;

  const tier = PLANS[tierId];
  if (tier.monthlyCredits === null) return;

  const client = getOblienClient();
  try {
    await client.namespaces.setQuota({
      namespace: org.oblienNamespace,
      service: SERVICE_CODE,
      quotaLimit: tier.monthlyCredits,
      onOverdraftAction: "stop_workspaces",
    });
  } catch (err) {
    throw new Error(
      `Failed to set Oblien quota (${tier.id}) on namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }

  // Lift the credit-exhausted gate if it was engaged. Idempotent —
  // restoreFromExhausted short-circuits when status is already active.
  if (org.subscriptionStatus === EXHAUSTED_STATUS) {
    await restoreFromExhausted(orgId);
  }
}

/**
 * Add delta credits to the org's current quota ceiling. Used by the
 * topup webhook handler — Stripe charge clears, we want the org's
 * Oblien limit to expand by the pack size without losing the existing
 * tier allotment + accumulated usage.
 *
 * Implementation: read current limit via `getDetails`, then setQuota
 * with the sum. There is no incremental "add" endpoint on Oblien's
 * side. If no row exists yet (fresh namespace), delta becomes the
 * starting ceiling.
 *
 * No-op when the namespace isn't provisioned yet.
 *
 * Side effect: lifts the `credit_exhausted` gate when engaged — see
 * setQuotaForTier for the rationale; pack purchases on a suspended
 * namespace should restore access alongside the new ceiling.
 */
export async function addQuota(orgId: string, deltaCredits: number): Promise<void> {
  if (deltaCredits <= 0) return;

  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`addQuota: organization ${orgId} not found`);
  }
  if (!org.oblienNamespace) return;

  const state = await getQuotaState(orgId);
  // null state OR null limit (unlimited) → start from 0; otherwise
  // build on what's already there. Unlimited callers shouldn't be
  // calling addQuota in practice, but the safe interpretation is
  // "keep them unlimited" — short-circuit.
  if (state && state.quotaLimit === null) return;

  const current = state?.quotaLimit ?? 0;
  const next = current + deltaCredits;

  const client = getOblienClient();
  try {
    await client.namespaces.setQuota({
      namespace: org.oblienNamespace,
      service: SERVICE_CODE,
      quotaLimit: next,
      onOverdraftAction: "stop_workspaces",
    });
  } catch (err) {
    throw new Error(
      `Failed to add ${deltaCredits} to Oblien quota on namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }

  if (org.subscriptionStatus === EXHAUSTED_STATUS) {
    await restoreFromExhausted(orgId);
  }
}

/**
 * Anniversary reset: zero the quota_used counter, then re-apply the
 * tier's monthly allotment as the fresh ceiling. Two-step because
 * `resetQuota` doesn't accept a new limit and `setQuota` doesn't zero
 * usage — Oblien splits the concerns.
 *
 * Skips enterprise (monthlyCredits === null) — those orgs are reset
 * out-of-band via admin grant.
 *
 * No-op when the namespace isn't provisioned yet.
 *
 * Side effect: lifts the `credit_exhausted` gate when engaged. A
 * fresh period with a fresh ceiling should restore access; without
 * this the cron / Stripe invoice.paid handler would have to remember
 * a separate restore call.
 */
export async function resetAndRegrant(orgId: string, tierId: PlanTierId): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`resetAndRegrant: organization ${orgId} not found`);
  }
  if (!org.oblienNamespace) return;

  const tier = PLANS[tierId];
  if (tier.monthlyCredits === null) return;

  const client = getOblienClient();
  try {
    await client.namespaces.resetQuota({
      namespace: org.oblienNamespace,
      service: SERVICE_CODE,
    });
  } catch (err) {
    throw new Error(
      `Failed to reset Oblien quota on namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }

  // Re-apply the tier ceiling after the reset. setQuotaForTier already
  // handles the namespace + enterprise gates, but we've already paid
  // for those lookups — inline the call to avoid the extra DB round
  // trip + duplicate gating.
  try {
    await client.namespaces.setQuota({
      namespace: org.oblienNamespace,
      service: SERVICE_CODE,
      quotaLimit: tier.monthlyCredits,
      onOverdraftAction: "stop_workspaces",
    });
  } catch (err) {
    throw new Error(
      `Failed to re-apply ${tier.id} quota after reset on namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }

  if (org.subscriptionStatus === EXHAUSTED_STATUS) {
    await restoreFromExhausted(orgId);
  }
}

/**
 * Suspend the namespace and mark the org `credit_exhausted` — the
 * end of the `credits.depleted` webhook path. Idempotent: short-
 * circuits when the org is already exhausted (Oblien's suspend is
 * server-side idempotent too, but we still gate locally so a noisy
 * webhook doesn't fan out duplicate state transitions).
 *
 * Unlike `billing-hardcap.handleCreditExhausted`, this helper is the
 * Oblien-quota-only path: no audit row, no notification dispatch.
 * The webhook handler owns those side-effects so it can attach the
 * actual Oblien event id to the audit record. Keep this surface
 * narrow to "flip Oblien + flip column"; the orchestration lives in
 * the handler.
 *
 * No-op when the namespace isn't provisioned yet (still flips the
 * local column so middleware gating engages).
 */
export async function suspendIfExhausted(orgId: string): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`suspendIfExhausted: organization ${orgId} not found`);
  }
  if (org.subscriptionStatus === EXHAUSTED_STATUS) return;

  if (org.oblienNamespace) {
    const client = getOblienClient();
    try {
      await client.namespaces.suspend(org.oblienNamespace);
    } catch (err) {
      throw new Error(
        `Failed to suspend Oblien namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
      );
    }
  }

  await repos.organization.setSubscriptionStatus(orgId, EXHAUSTED_STATUS);
}

/**
 * Restore an exhausted org back to active — called after a topup or
 * tier change once we know the balance is positive again. Idempotent:
 * short-circuits when the org is already active. Activates the
 * Oblien namespace (Oblien's activate is itself idempotent) and
 * flips the local column.
 *
 * Pairs with `suspendIfExhausted` — symmetric narrow surface, owns
 * "flip Oblien + flip column" and nothing else.  Resource_limits
 * restoration on plan change lives in `billing-hardcap.restoreOblienLimits`
 * — this helper only manages the suspended ↔ active toggle, not the
 * per-tier ceilings.
 *
 * The `_tier` argument exists so the call site reads naturally
 * alongside addQuota / setQuotaForTier on the topup path; we use
 * resolvePlanTier on the org's column rather than trusting the
 * argument blind (defends against stale tier ids in flight).
 */
export async function restoreFromExhausted(orgId: string): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`restoreFromExhausted: organization ${orgId} not found`);
  }
  if (org.subscriptionStatus === ACTIVE_STATUS) return;

  if (org.oblienNamespace) {
    const client = getOblienClient();
    try {
      await client.namespaces.activate(org.oblienNamespace);
    } catch (err) {
      throw new Error(
        `Failed to activate Oblien namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
      );
    }
  }

  // Pin to a known tier id in case a future code path wants to log
  // the post-restore tier on the same row — keeps the resolution
  // local rather than re-deriving in callers.
  void resolvePlanTier(org.planTierId);

  await repos.organization.setSubscriptionStatus(orgId, ACTIVE_STATUS);
}

/* ------------------------------------------------------------------ */
/* Raw metered usage (buckets + totals)                                */
/* ------------------------------------------------------------------ */

/**
 * Input for `getNamespaceUsage` — the controller hands us already-
 * parsed `Date`s plus an optional bucket size. We marshal to the
 * ISO8601 strings Oblien expects at the boundary so callers don't
 * have to remember the format.
 */
export interface UsageRangeInput {
  organizationId: string;
  from: Date;
  to: Date;
  /** Bucket granularity. Defaults to `"day"` to match Oblien's own default. */
  groupBy?: "hour" | "day";
}

/**
 * Read the raw metered usage-unit rollup for the org's namespace over
 * a time range. Buckets + totals come straight from Oblien — we don't
 * re-derive `vcpu_hours` / `gb_hours` / `credits`, those are part of
 * the SDK contract.
 *
 * Returns `null` when the org hasn't been provisioned a namespace yet
 * (so the dashboard can render an empty state). Throws if Oblien
 * surfaces an error — the controller decides how loudly to fail.
 *
 * Note: response keys are snake_case (`group_by`, `cpu_time_minutes`,
 * …) and we forward them as-is rather than transforming. The chart
 * client already speaks Oblien's vocabulary; renaming here would mean
 * a translation layer at every reader.
 */
export async function getNamespaceUsage(
  input: UsageRangeInput,
): Promise<NamespaceUsageUnits | null> {
  const org = await repos.organization.findById(input.organizationId);
  if (!org) {
    throw new Error(`getNamespaceUsage: organization ${input.organizationId} not found`);
  }
  if (!org.oblienNamespace) return null;

  const client = getOblienClient();
  try {
    const res = await client.namespaces.usageUnits(org.oblienNamespace, {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      groupBy: input.groupBy ?? "day",
    });
    return res.data;
  } catch (err) {
    throw new Error(
      `Failed to read Oblien usage units for namespace ${org.oblienNamespace} (org ${input.organizationId}): ${safeErrorMessage(err)}`,
    );
  }
}
