"use client";

import { useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";

export function OpenStripePortalButton({ label = "Open Stripe Portal" }: { label?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`Portal request failed (${res.status})`);
      }
      const body = (await res.json()) as { data?: { portalUrl?: string }; portalUrl?: string };
      const portalUrl = body.data?.portalUrl ?? body.portalUrl;
      if (!portalUrl) {
        throw new Error("Portal URL missing from response");
      }
      window.location.href = portalUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open Stripe portal");
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={openPortal}
        disabled={pending}
        className="group relative inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground transition-all disabled:opacity-60"
      >
        <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity group-hover:opacity-60" />
        <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
        <span className="relative flex items-center gap-1.5">
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {label}
          {!pending ? <ArrowUpRight className="size-3.5" /> : null}
        </span>
      </button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
