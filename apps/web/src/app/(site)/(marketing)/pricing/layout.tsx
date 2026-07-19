import type { Metadata } from "next";
import type { ReactNode } from "react";

const TITLE = "Pricing";
const DESCRIPTION =
  "Openship pricing - self-hosted is free forever and open source (Apache 2.0). Managed Openship Cloud is coming soon; pricing will be announced before launch.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
    url: "/pricing",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
  },
};

const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Is self-hosting really free?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes - free forever. Run the full platform on your own servers with no metering, no seat caps, and no telemetry. It's open source under Apache 2.0.",
      },
    },
    {
      "@type": "Question",
      name: "How much does Openship Cloud cost?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Cloud pricing hasn't been announced yet. We're still finalizing it - leave your email on the contact page and we'll let you know before it launches.",
      },
    },
    {
      "@type": "Question",
      name: "Can I move between self-hosted and cloud later?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "That's the goal - your containers travel as-is, no rebuild, no rewrites. Once Cloud launches, moving between it and self-hosting will be a one-click change.",
      },
    },
    {
      "@type": "Question",
      name: "What's the license?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Apache 2.0 - a permissive license. Use it, modify it, and ship it however you like, including in commercial or closed-source products. Run it in your cloud, on a Raspberry Pi, or in production for a SaaS - no restrictions, no copyleft obligations.",
      },
    },
    {
      "@type": "Question",
      name: "Do you store my source code?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Only what's needed to build. We never store unencrypted secrets, and source is fetched fresh from your repo for each build. Self-hosted keeps everything on your infrastructure by definition.",
      },
    },
  ],
};

const productLd = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Openship",
  description:
    "Open source, self-hostable deployment platform with AI-powered builds, free SSL, instant rollbacks, and CLI/MCP support.",
  brand: { "@type": "Brand", name: "Openship" },
  category: "Software / Developer Tools",
  offers: [
    {
      "@type": "Offer",
      name: "Self-hosted",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      description: "Self-hosted, Apache 2.0. Free forever on your own servers.",
      url: "https://openship.io/pricing",
    },
    {
      "@type": "Offer",
      name: "Openship Cloud",
      priceCurrency: "USD",
      availability: "https://schema.org/PreOrder",
      description: "Fully managed cloud - coming soon. Pricing announced before launch.",
      url: "https://openship.io/pricing",
    },
  ],
};

const breadcrumbLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
    { "@type": "ListItem", position: 2, name: "Pricing", item: "https://openship.io/pricing" },
  ],
};

export default function PricingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      {children}
    </>
  );
}
