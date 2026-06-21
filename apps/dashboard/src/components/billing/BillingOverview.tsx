"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Sparkles } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { PLANS } from "@repo/core";
import { api } from "@/lib/api/client";
import type { BillingState } from "@/lib/api/billing";

export type { BillingState };

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/**
 * Legacy compatibility — older callers (and the mock data layer) still
 * import `BillingData`. The two shapes diverged when we switched to the
 * credits model; keep the alias so the file's named exports stay stable
 * while the rest of the dashboard migrates.
 */
export type BillingData = BillingState;

interface BillingOverviewProps {
  state: BillingState;
}

/** One bucket of the `/billing/usage` response. */
interface UsageBucket {
  timestamp: string;
  credits: number;
}

interface UsageResponse {
  data: {
    from: string;
    to: string;
    groupBy: "hour" | "day";
    usage: {
      buckets: UsageBucket[];
    } | null;
  };
}

interface TopupPack {
  id: string;
  name: string;
  credits_milli: number;
  price_cents: number;
  stripePriceId: string;
  sortOrder: number;
}

interface TopupPacksResponse {
  data: TopupPack[];
}

interface TopupCheckoutResponse {
  data: { checkoutUrl: string };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Credits are stored in milli-credits server-side; flatten to whole
 * credits with commas for display. Numbers below 1 credit are rendered
 * as "0" rather than a fractional value — the overview reads as a coarse
 * balance, not an accountant's ledger.
 */
function formatCredits(milliCredits: number): string {
  const credits = Math.floor(milliCredits / 1000);
  return credits.toLocaleString();
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function pctUsed(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

function barColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 75) return "bg-amber-500";
  return "bg-primary";
}

/**
 * Days remaining until the current billing period ends. Returns `null`
 * when the period end is missing or already in the past — the caller
 * renders a neutral chip in that case rather than "Resets in -3 days".
 */
function daysUntil(end: Date | string | null): number | null {
  if (!end) return null;
  const endMs = typeof end === "string" ? Date.parse(end) : end.getTime();
  if (Number.isNaN(endMs)) return null;
  const diff = endMs - Date.now();
  if (diff <= 0) return null;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function statusPillClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "active") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
  if (s === "past_due" || s === "unpaid") return "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20";
  if (s === "canceled" || s === "cancelled") return "bg-muted text-muted-foreground border-border";
  return "bg-muted text-muted-foreground border-border";
}

/* ------------------------------------------------------------------ */
/*  Upgrade button (kept exported — used elsewhere)                   */
/* ------------------------------------------------------------------ */

export function UpgradeButton({ children, onClick, className = "" }: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground transition-all ${className}`}
    >
      <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity group-hover:opacity-60" />
      <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
      <span className="relative flex items-center gap-1.5">{children}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function BalanceHero({ state }: { state: BillingState }) {
  const { quotaLimit, quotaUsed, quotaRemaining } = state.balance;
  const pct = pctUsed(quotaUsed, quotaLimit);
  const days = daysUntil(state.currentPeriod.end);

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Credit balance
          </p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-4xl font-semibold tabular-nums tracking-tight text-foreground sm:text-5xl">
              {formatCredits(quotaRemaining)}
            </span>
            <span className="text-base text-muted-foreground">credits</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            of {formatCredits(quotaLimit)} total
          </p>
        </div>

        <div className="flex shrink-0 items-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
            {days !== null
              ? `Resets in ${days} day${days === 1 ? "" : "s"}`
              : "No reset scheduled"}
          </span>
        </div>
      </div>

      <div className="mt-5">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full ${barColor(pct)} transition-all duration-500`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{formatCredits(quotaUsed)} used</span>
          <span>{Math.round(pct)}%</span>
        </div>
      </div>
    </div>
  );
}

function RecentActivityCard() {
  const [buckets, setBuckets] = useState<UsageBucket[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const to = new Date();
        const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
        const qs = new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
          groupBy: "day",
        });
        const res = await api.get<UsageResponse>(`billing/usage?${qs.toString()}`);
        if (cancelled) return;
        setBuckets(res.data.usage?.buckets ?? []);
      } catch {
        if (!cancelled) setError("Failed to load usage");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Convert milli-credits to whole credits so the sparkline reads in the
  // same unit as the balance hero. Empty arrays still render a flat axis
  // (recharts handles a length-0 dataset, but the visual is the same as
  // the loading state — explicit empty copy is clearer).
  const data = (buckets ?? []).map((b) => ({
    timestamp: b.timestamp,
    credits: Math.max(0, b.credits / 1000),
  }));

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Recent activity</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Last 7 days</p>
        </div>
        <Link
          href="/billing/usage"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          View full usage
          <ArrowUpRight className="size-3" />
        </Link>
      </div>

      <div className="h-20">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {error}
          </div>
        ) : data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No usage yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="credits"
                stroke="hsl(var(--primary))"
                strokeWidth={1.75}
                fill="url(#sparkFill)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function PlanSummaryCard({ state }: { state: BillingState }) {
  const plan = PLANS[state.tier];
  const planName = plan?.name ?? state.tier;

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Current plan
          </p>
          <div className="mt-1 flex items-center gap-2">
            <h3 className="text-lg font-semibold text-foreground">{planName}</h3>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${statusPillClass(state.status)}`}
            >
              {state.status.replace(/_/g, " ")}
            </span>
          </div>
          {plan?.description && (
            <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
          )}
        </div>

        {state.tier === "free" && (
          <Link
            href="/billing/plans"
            className="relative inline-flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity hover:opacity-60" />
            <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
            <span className="relative flex items-center gap-1.5">
              <Sparkles className="size-3.5" />
              Upgrade to Pro
            </span>
          </Link>
        )}
      </div>
    </div>
  );
}

function BuyCreditsCard() {
  const [packs, setPacks] = useState<TopupPack[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buyingPackId, setBuyingPackId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.get<TopupPacksResponse>("billing/topup-packs");
        if (cancelled) return;
        // Show the cheapest options first regardless of the server's
        // configured ordering — the overview is "quick buy", deeper
        // selection lives on /billing/topups.
        const sorted = [...res.data].sort((a, b) => a.sortOrder - b.sortOrder);
        setPacks(sorted.slice(0, 2));
      } catch {
        if (!cancelled) setError("Failed to load packs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleBuy(packId: string) {
    setBuyingPackId(packId);
    try {
      const res = await api.post<TopupCheckoutResponse>("billing/topup", { packId });
      window.location.href = res.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout");
      setBuyingPackId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Need more credits?</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One-time top-ups, no subscription change
          </p>
        </div>
        <Link
          href="/billing/topups"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          See all packs
          <ArrowUpRight className="size-3" />
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="py-4 text-xs text-muted-foreground">{error}</p>
      ) : !packs || packs.length === 0 ? (
        <p className="py-4 text-xs text-muted-foreground">No top-up packs available.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {packs.map((pack) => {
            const isBuying = buyingPackId === pack.id;
            return (
              <button
                key={pack.id}
                onClick={() => handleBuy(pack.id)}
                disabled={buyingPackId !== null}
                className="group flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {formatCredits(pack.credits_milli)} credits
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatDollars(pack.price_cents)} one-time
                  </p>
                </div>
                <span className="ml-3 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                  {isBuying ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <>
                      Buy
                      <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export const BillingOverview: React.FC<BillingOverviewProps> = ({ state }) => {
  return (
    <div className="flex flex-col gap-5">
      <BalanceHero state={state} />
      <RecentActivityCard />
      <PlanSummaryCard state={state} />
      <BuyCreditsCard />
    </div>
  );
};
