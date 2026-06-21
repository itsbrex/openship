"use client";

import { useSelectedLayoutSegment } from "next/navigation";

/**
 * Body of the billing layout. Wraps the active tab's children and an
 * optional sidebar slot, hiding the sidebar on the "plans" tab (the
 * plans grid wants the full content width). Client-side because the
 * sidebar visibility depends on the active layout segment.
 */
export function BillingContent({
  children,
  sidebar,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode | null;
}) {
  const segment = useSelectedLayoutSegment();
  const showSidebar = sidebar !== null && segment !== "plans";

  if (!showSidebar) {
    return <div className="min-w-0">{children}</div>;
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0">{children}</div>
      {sidebar}
    </div>
  );
}
