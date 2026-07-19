import { Navbar, Footer } from "@/components/landing";

/* ─── Plans ──────────────────────────────────────────────────── */

type Plan = {
  n: string;
  name: string;
  tag: string;
  price: string;
  priceNote: string;
  lead: string;
  cta: string;
  ctaHref: string;
  external?: boolean;
  features: string[];
  highlight?: boolean;
};

const PLANS: Plan[] = [
  {
    n: "01",
    name: "Self-hosted",
    tag: "Free forever",
    price: "$0",
    priceNote: "On servers you own",
    lead: "Run the full platform on your own server. No metering, no caps, no telemetry — free forever.",
    cta: "Read the source",
    ctaHref: "https://github.com/oblien/openship",
    external: true,
    features: [
      "Full platform, open source (Apache 2.0)",
      "Unlimited deploys, domains, projects",
      "All managed services — Postgres, Redis, mail",
      "CLI, web, desktop — same backend",
      "Community support",
    ],
  },
  {
    n: "02",
    name: "Openship Cloud",
    tag: "Managed",
    price: "Coming soon",
    priceNote: "Pricing announced later",
    lead: "Fully managed Openship — multi-region, auto-scaling, backups included. Pricing is still being finalized.",
    cta: "Get notified",
    ctaHref: "/contact",
    features: [
      "Everything in self-hosted",
      "Managed multi-region edge",
      "Auto-scaling and zero-downtime deploys",
      "Daily backups, point-in-time recovery",
      "Built-in mail server, unlimited domains",
      "Live monitoring and alerts",
    ],
    highlight: true,
  },
];

/* ─── FAQ ────────────────────────────────────────────────────── */

const FAQ = [
  {
    q: "Is self-hosting really free?",
    a: "Yes — free forever. Run the full platform on your own servers with no metering, no seat caps, and no telemetry. It's open source under Apache 2.0.",
  },
  {
    q: "How much does Openship Cloud cost?",
    a: "Cloud pricing hasn't been announced yet. We're still finalizing it — leave your email on the contact page and we'll let you know before it launches.",
  },
  {
    q: "Can I move between self-hosted and cloud later?",
    a: "That's the goal — your containers travel as-is, no rebuild, no rewrites. Once Cloud launches, moving between it and self-hosting will be a one-click change.",
  },
  {
    q: "What's the license?",
    a: "Apache 2.0 — a permissive license. Use it, modify it, fork it, and ship it in commercial or closed-source products, no strings attached. Run it in your cloud, on a Raspberry Pi, or in production for a SaaS.",
  },
  {
    q: "Do you store my source code?",
    a: "Only what's needed to build. We never store unencrypted secrets, and source is fetched fresh from your repo for each build. Self-hosted keeps everything on your infrastructure by definition.",
  },
];

/* ─── Page ───────────────────────────────────────────────────── */

export default function PricingPage() {
  return (
    <>
      <Navbar />
      <main className="pp-root">

        {/* ── Hero ───────────────────────────────────────────── */}
        <section className="pp-hero">
          <div className="pp-hero-glow" aria-hidden="true" />
          <div className="pp-container pp-hero-inner">
            <p className="pp-eyebrow">Pricing</p>
            <h1 className="pp-headline">
              Free to self-host.<br />
              <span className="pp-headline-soft">Cloud pricing coming soon.</span>
            </h1>
            <p className="pp-sub">
              The full platform is open source and free to run on your own
              servers, today. Managed Openship Cloud is on the way — pricing
              will be announced before it launches.
            </p>

            <ul className="pp-hero-trust">
              <li>Free forever, self-hosted</li>
              <li>Open source · Apache 2.0</li>
              <li>No credit card</li>
              <li>No lock-in</li>
            </ul>
          </div>
        </section>

        {/* ── Plan cards ─────────────────────────────────────── */}
        <section className="pp-plans-section">
          <div className="pp-container">
            <div className="pp-plans">
              {PLANS.map((p) => (
                <article
                  key={p.name}
                  className={`pp-plan ${p.highlight ? "pp-plan--highlight" : ""}`}
                >
                  {p.highlight && <span className="pp-plan-ribbon">Coming soon</span>}

                  <div className="pp-plan-top">
                    <span className="pp-plan-n">{p.n}</span>
                    <span className="pp-plan-tag">{p.tag}</span>
                  </div>

                  <h2 className="pp-plan-name">{p.name}</h2>
                  <p className="pp-plan-lead">{p.lead}</p>

                  <div className="pp-plan-price">
                    <span className="pp-plan-amt">{p.price}</span>
                    <span className="pp-plan-pricenote">{p.priceNote}</span>
                  </div>

                  <a
                    href={p.ctaHref}
                    {...(p.external ? { target: "_blank", rel: "noreferrer" } : {})}
                    className={`pp-plan-cta ${p.highlight ? "pp-plan-cta--filled" : ""}`}
                  >
                    {p.cta}
                  </a>

                  <ul className="pp-plan-features">
                    {p.features.map((f) => (
                      <li key={f}>
                        <svg className="pp-plan-check" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <path d="M4 10.5l4 4 8-10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── FAQ ────────────────────────────────────────────── */}
        <section className="pp-faq-section">
          <div className="pp-container">
            <header className="pp-faq-head">
              <p className="pp-eyebrow">Questions</p>
              <h2 className="pp-faq-title">Answered.</h2>
            </header>

            <div className="pp-faq-list">
              {FAQ.map((f) => (
                <details key={f.q} className="pp-faq-item">
                  <summary className="pp-faq-q">
                    <span>{f.q}</span>
                    <span className="pp-faq-icon" aria-hidden="true">
                      <svg viewBox="0 0 16 16" fill="none">
                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </summary>
                  <p className="pp-faq-a">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ── Final CTA ──────────────────────────────────────── */}
        <section className="pp-end">
          <div className="pp-container">
            <div className="pp-end-card">
              <h2 className="pp-end-title">Start self-hosting today.</h2>
              <p className="pp-end-sub">
                The full platform is free and open source. Deploy it on your own
                server now — and be first to know when Cloud lands.
              </p>
              <div className="pp-end-cta-row">
                <a href="https://github.com/oblien/openship" target="_blank" rel="noreferrer" className="pp-btn pp-btn--primary">
                  Self-host on GitHub
                </a>
                <a href="/contact" className="pp-btn pp-btn--ghost">
                  Get notified about Cloud
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
