"use client";

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { BILLING_TABS, type BillingTab } from "./billing-shared";

/**
 * Tab strip for the billing layout. Pulled into its own client component
 * because `useSelectedLayoutSegment` is client-only, while the surrounding
 * layout is a server component (it fetches billing state for the sidebar).
 */
export function BillingTabBar() {
  const segment = useSelectedLayoutSegment();
  const activeTab: BillingTab =
    segment && BILLING_TABS.some((tab) => tab.key === segment)
      ? (segment as BillingTab)
      : "overview";

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border/50">
      {BILLING_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = activeTab === tab.key;

        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={`relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
            }`}
          >
            <Icon className="size-4" />
            {tab.label}
            {active && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-primary" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
