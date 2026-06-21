import { z } from "zod";

/**
 * Subscription checkout body. `planTierId` mirrors the constants-side
 * naming (replaces the legacy `planId` union which only covered paid
 * tiers) — the webhook reads the same key off `metadata.planTierId`,
 * so keep them in sync if you rename.
 *
 * Enterprise is excluded — it's contact-sales, not self-serve.
 */
export const createSubscriptionSchema = z.object({
  planTierId: z.enum(["pro", "team"]),
  interval: z.enum(["monthly", "annual"]),
});
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;

/**
 * One-shot top-up checkout body. The webhook handler resolves the
 * pack via `metadata.packId` against the `CREDIT_PACKS` catalog —
 * keep the key name identical here.
 */
export const createTopupSchema = z.object({
  packId: z.string().min(1).max(64),
});
export type CreateTopupInput = z.infer<typeof createTopupSchema>;

