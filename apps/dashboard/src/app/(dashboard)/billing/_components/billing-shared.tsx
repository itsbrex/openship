import Link from "next/link";
import {
  ArrowUpRight,
  BarChart3,
  Building2,
  Coins,
  CreditCard,
  Crown,
  LayoutDashboard,
  Receipt,
  Sparkles,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PLANS, type PlanTierId } from "@repo/core";
import type { BillingState } from "@/lib/api/billing";
import { OpenStripePortalButton } from "./OpenStripePortalButton";

export type { BillingState };

export type BillingTab =
  | "overview"
  | "usage"
  | "plans"
  | "topups"
  | "payment"
  | "invoices";

export const BILLING_TABS: Array<{
  key: BillingTab;
  label: string;
  href: string;
  icon: LucideIcon;
}> = [
  { key: "overview", label: "Overview", href: "/billing/overview", icon: LayoutDashboard },
  { key: "usage", label: "Usage", href: "/billing/usage", icon: BarChart3 },
  { key: "plans", label: "Plans", href: "/billing/plans", icon: Crown },
  { key: "topups", label: "Top-ups", href: "/billing/topups", icon: Coins },
  { key: "payment", label: "Payment Method", href: "/billing/payment", icon: CreditCard },
  { key: "invoices", label: "Invoices", href: "/billing/invoices", icon: Receipt },
];

const PLAN_ICON: Record<PlanTierId, LucideIcon> = {
  free: Zap,
  pro: Sparkles,
  team: Building2,
  enterprise: Crown,
};

const PLAN_COLOR: Record<PlanTierId, string> = {
  free: "bg-muted text-muted-foreground",
  pro: "bg-primary/10 text-primary",
  team: "bg-muted text-foreground",
  enterprise: "bg-muted text-foreground",
};

function BillingCtaLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`group relative inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground transition-all ${className}`}
    >
      <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity group-hover:opacity-60" />
      <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
      <span className="relative flex items-center gap-1.5">{children}</span>
    </Link>
  );
}

function formatPlanPrice(tier: PlanTierId): string {
  const plan = PLANS[tier];
  const monthly = plan.price.monthly;
  if (monthly === null) return "Contact sales";
  if (monthly === 0) return "Free forever";
  return `$${(monthly / 100).toFixed(0)}/mo`;
}

function formatStatusLabel(status: string): string {
  if (!status) return "Inactive";
  return status
    .split("_")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

const NEXT_PLAN: Partial<Record<PlanTierId, PlanTierId>> = {
  free: "pro",
  pro: "team",
};

export function BillingSidebar({ state }: { state: BillingState }) {
  const plan = PLANS[state.tier];
  const nextPlan = NEXT_PLAN[state.tier];
  const PlanIcon = PLAN_ICON[state.tier];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex size-10 items-center justify-center rounded-xl ${PLAN_COLOR[state.tier]}`}>
            <PlanIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{plan.name} Plan</p>
            <p className="text-xs text-muted-foreground">{formatPlanPrice(state.tier)}</p>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
          <span className="text-xs text-muted-foreground">Status</span>
          <span className="text-xs font-medium text-foreground">{formatStatusLabel(state.status)}</span>
        </div>

        {nextPlan && (
          <BillingCtaLink href="/billing/plans" className="w-full justify-center">
            Upgrade to {PLANS[nextPlan].name}
            <ArrowUpRight className="size-3.5" />
          </BillingCtaLink>
        )}
      </div>
    </div>
  );
}

export function PaymentMethodPanel() {
  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="border-b border-border/50 p-5">
        <h2 className="text-base font-semibold text-foreground">Payment method</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Cards, bank accounts, and billing details are managed in the Stripe
          Customer Portal. Open the portal to add, remove, or update your
          payment methods.
        </p>
      </div>
      <div className="p-5">
        <OpenStripePortalButton />
      </div>
    </div>
  );
}

export function InvoicesPanel() {
  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="border-b border-border/50 p-5">
        <h2 className="text-base font-semibold text-foreground">Invoices</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Invoices and receipts live in the Stripe Customer Portal. Open the
          portal to view your billing history and download PDF invoices.
        </p>
      </div>
      <div className="p-5">
        <OpenStripePortalButton />
      </div>
    </div>
  );
}
