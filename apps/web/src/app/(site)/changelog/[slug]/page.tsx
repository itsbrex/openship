import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { changelogSource } from "@/lib/source";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { ChangelogEntries, slugOf, type Entry } from "../_components/changelog-entries";
import "../changelog.css";

type Params = Promise<{ slug: string }>;

function findEntry(slug: string): Entry | undefined {
  return (changelogSource.getPages() as unknown as Entry[]).find(
    (e) => slugOf(e.url) === slug,
  );
}

export function generateStaticParams() {
  return (changelogSource.getPages() as unknown as Entry[]).map((e) => ({
    slug: slugOf(e.url),
  }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const entry = findEntry(slug);
  if (!entry) return { title: "Changelog" };

  const title = `${entry.data.version} · ${entry.data.title}`;
  const description = entry.data.description ?? entry.data.title;
  const url = `/changelog/${slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${title} - Openship`,
      description,
      url,
      type: "article",
      siteName: "Openship",
      locale: "en_US",
      publishedTime: entry.data.date,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} - Openship`,
      description,
    },
  };
}

export default async function ChangelogEntryPage({ params }: { params: Params }) {
  const { slug } = await params;
  const target = findEntry(slug);
  if (!target) notFound();

  // Pin the shared entry to the top (#1); the rest follow newest-first.
  const rest = (changelogSource.getPages() as unknown as Entry[])
    .filter((e) => e.url !== target.url)
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime());
  const ordered: Entry[] = [target, ...rest];

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-28 sm:pt-32">
        <header className="mb-8 max-w-2xl">
          <Link
            href="/changelog"
            className="th-text-secondary text-[13px] font-medium uppercase tracking-[0.14em] transition-colors hover:opacity-80"
          >
            ← Changelog
          </Link>
          <h1 className="th-text-heading mt-4 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
            {target.data.title}
          </h1>
          <p className="th-text-body mt-5 text-lg leading-relaxed">
            {target.data.description ?? "Features, fixes, and improvements shipping in Openship."}
          </p>
        </header>

        <ChangelogEntries entries={ordered} highlightSlug={slug} />
      </main>
      <Footer />
    </>
  );
}
