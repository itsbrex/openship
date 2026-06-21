import { notFound } from "next/navigation";
import type { PlanId } from "@repo/core";
import { BillingOverview } from "@/components/billing/BillingOverview";
import { BillingUsage } from "@/components/billing/BillingUsage";
import { BillingTopups } from "@/components/billing/BillingTopups";
import { BillingPlansRoute } from "../_components/BillingPlansRoute";
import { InvoicesPanel, PaymentMethodPanel } from "../_components/billing-shared";
import { serverApi, ServerApiError } from "@/lib/server/api";
import type { BillingState } from "@/lib/api/billing";

interface BillingStateResponse {
  data: BillingState;
}

async function fetchBillingState(): Promise<BillingState | null> {
  try {
    const res = await serverApi.get<BillingStateResponse>("/billing/state", {
      cache: "no-store",
    });
    return res?.data ?? null;
  } catch (err) {
    if (err instanceof ServerApiError && (err.status === 404 || err.status === 501)) {
      return null;
    }
    throw err;
  }
}

function BillingUnavailable() {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
      <h2 className="text-base font-semibold text-foreground">
        Billing is not enabled for this workspace
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Billing is only available when running in SaaS mode. Switch the
        instance to SaaS, or contact your administrator to enable billing
        for this organization.
      </p>
    </div>
  );
}

export default async function BillingTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  const validTabs = ["overview", "usage", "plans", "topups", "payment", "invoices"];
  if (!validTabs.includes(tab)) {
    notFound();
  }

  const state = await fetchBillingState();

  if (!state) {
    return <BillingUnavailable />;
  }

  switch (tab) {
    case "overview":
      return <BillingOverview state={state} />;
    case "usage":
      return <BillingUsage state={state} />;
    case "plans":
      return <BillingPlansRoute currentPlan={state.tier as PlanId} />;
    case "topups":
      return <BillingTopups state={state} />;
    case "payment":
      return <PaymentMethodPanel />;
    case "invoices":
      return <InvoicesPanel />;
    default:
      notFound();
  }
}
