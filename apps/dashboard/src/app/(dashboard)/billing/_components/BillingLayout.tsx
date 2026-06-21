import { PageContainer } from "@/components/ui/PageContainer";
import { serverApi, ServerApiError } from "@/lib/server/api";
import { BillingSidebar, type BillingState } from "./billing-shared";
import { BillingTabBar } from "./BillingTabBar";
import { BillingContent } from "./BillingContent";

/** Wire shape of `GET /api/billing/state` — the controller wraps in `{ data }`. */
interface BillingStateEnvelope {
  data: BillingState;
}

/**
 * Fetch the active org's billing snapshot server-side. Returns null when
 * the org isn't configured for billing (404) or any other API error — the
 * caller renders the layout without a sidebar in that case rather than
 * failing the whole billing area.
 */
async function fetchBillingState(): Promise<BillingState | null> {
  try {
    const res = await serverApi.get<BillingStateEnvelope>("/billing/state", {
      cache: "no-store",
    });
    return res?.data ?? null;
  } catch (err) {
    if (err instanceof ServerApiError && (err.status === 404 || err.status === 501)) {
      return null;
    }
    // Any other failure (auth, network) — render without sidebar rather
    // than crash the whole billing area. Tabs handle their own error UI.
    return null;
  }
}

export async function BillingLayout({ children }: { children: React.ReactNode }) {
  const state = await fetchBillingState();

  return (
    <PageContainer className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
          Billing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground/70">
          Manage your subscription, usage, and payment methods.
        </p>
      </div>

      <BillingTabBar />

      <BillingContent sidebar={state ? <BillingSidebar state={state} /> : null}>
        {children}
      </BillingContent>
    </PageContainer>
  );
}
