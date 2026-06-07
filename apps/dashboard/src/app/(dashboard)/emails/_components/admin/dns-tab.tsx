"use client";

/**
 * DNS tab - reference of the records this mail server expects.
 *
 * Read-only. The install wizard's banner is the right place to *set*
 * records; this tab is for audits and re-checks. The Health tab has the
 * live "are these actually published?" scan.
 *
 * Layout:
 *   - Page header (h2 + sub) - matches Domains/Mailboxes tab style.
 *   - Card with the records list, rendered via the shared
 *     DnsRecordsView in 2-column grid mode so it doesn't push the page
 *     beyond the visible viewport.
 */

import Link from "next/link";
import { FileText, Activity, ArrowRight } from "lucide-react";
import type { DnsRecords, MailSetupStatus } from "@/lib/api";
import { DnsRecordsView } from "@/components/shared/DnsRecordsView";
import { SectionCard } from "./_shared/section-card";

interface DnsTabProps {
  status: MailSetupStatus;
}

export function DnsTab({ status }: DnsTabProps) {
  const domain = status.domain ?? "";

  if (!status.dnsRecords || !domain) {
    return (
      <div className="space-y-5">
        <Header />
        <div className="bg-card rounded-2xl border border-border/50 py-16 px-6 text-center">
          <div className="mx-auto w-16 h-16 rounded-full bg-muted/60 flex items-center justify-center mb-5">
            <FileText
              className="size-7 text-muted-foreground/60"
              strokeWidth={1.5}
            />
          </div>
          <h3
            className="text-lg font-medium text-foreground/80 mb-2"
            style={{ letterSpacing: "-0.2px" }}
          >
            No DNS records on file
          </h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
            The install wizard generates DNS records during the DKIM step. If
            this server's setup is incomplete, finish the wizard to populate
            this view.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Header />

      <SectionCard
        title="Records for publishing"
        description={`Publish these at your DNS provider for ${domain}.`}
        icon={FileText}
        density="split"
      >
        <div className="p-5">
          <DnsRecordsView
            records={status.dnsRecords as unknown as DnsRecords}
            domain={domain}
            columns={2}
          />
        </div>
      </SectionCard>

      <Link
        href="?tab=health"
        replace
        scroll={false}
        className="flex items-center justify-between gap-4 p-5 rounded-2xl border border-border/50 bg-card hover:bg-muted/30 hover:border-border transition-colors group"
      >
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
            <Activity
              className="size-5 text-muted-foreground"
              strokeWidth={2}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              Verify these are actually published
            </p>
            <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">
              Run a live DNS lookup against your domain and compare it to the
              records above. Lives in the Health tab.
            </p>
          </div>
        </div>
        <ArrowRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors shrink-0" />
      </Link>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">DNS records</h2>
      <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
        The records that need to exist at your DNS provider for mail
        delivery. Reference copy - for "is this actually live?", use the
        Health tab's DNS scan.
      </p>
    </div>
  );
}
