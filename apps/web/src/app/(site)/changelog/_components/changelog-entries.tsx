import type { ChangelogFrontmatter } from "@/lib/source";
import { ShareButton } from "./share-button";

export type Entry = { url: string; data: ChangelogFrontmatter };

const TAG_STYLE: Record<string, { bg: string; fg: string }> = {
  feature: { bg: "var(--th-clr-sea-bg)", fg: "var(--th-clr-sea)" },
  fix: { bg: "rgba(147,197,253,.16)", fg: "#2563eb" },
  breaking: { bg: "var(--th-clr-terra-bg)", fg: "var(--th-clr-terra)" },
  security: { bg: "rgba(253,230,138,.30)", fg: "#b45309" },
};

/** Trailing path segment of a changelog page url → the shareable slug. */
export function slugOf(url: string): string {
  return url.split("/").filter(Boolean).pop() ?? "";
}

function fmtDate(iso: string): { top: string; year: string } {
  const d = new Date(iso);
  return {
    top: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    year: String(d.getFullYear()),
  };
}

/**
 * Renders the changelog entry list. `highlightSlug` (set on `/changelog/<slug>`)
 * gives that one entry a highlighted card treatment; callers pin it to the top
 * so a shared link lands on it as entry #1.
 */
export function ChangelogEntries({
  entries,
  highlightSlug,
}: {
  entries: Entry[];
  highlightSlug?: string;
}) {
  return (
    <>
      {entries.map((entry) => {
        const slug = slugOf(entry.url);
        const highlighted = slug === highlightSlug;
        const { top, year } = fmtDate(entry.data.date);
        const Body = entry.data.body;
        return (
          <article
            key={entry.url}
            id={slug}
            className={`changelog-entry grid grid-cols-1 gap-4 py-12 sm:grid-cols-[140px_1fr] sm:gap-8 ${
              highlighted ? "changelog-highlight" : "border-t"
            }`}
            style={highlighted ? undefined : { borderColor: "var(--th-bd-subtle)" }}
          >
            <div className="sm:pt-1">
              <div className="th-text-title text-sm font-semibold">{top}</div>
              <div className="th-text-muted text-sm">{year}</div>
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="th-text-heading text-xl font-semibold tracking-[-0.01em]">
                  {entry.data.version}
                </span>
                {(entry.data.tags ?? []).map((t) => {
                  const s =
                    TAG_STYLE[t] ?? {
                      bg: "var(--th-sf-06)",
                      fg: "var(--th-text-secondary)",
                    };
                  return (
                    <span
                      key={t}
                      className="rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ background: s.bg, color: s.fg }}
                    >
                      {t}
                    </span>
                  );
                })}
                <ShareButton slug={slug} className="ml-auto" />
              </div>
              {entry.data.title && (
                <h2 className="th-text-title mt-2 text-lg font-medium">
                  {entry.data.title}
                </h2>
              )}
              <div className="changelog-prose th-text-body mt-4 text-[15px] leading-relaxed">
                <Body />
              </div>
            </div>
          </article>
        );
      })}
    </>
  );
}
