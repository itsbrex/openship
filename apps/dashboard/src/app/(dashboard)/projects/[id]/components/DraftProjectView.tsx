"use client";

/**
 * DraftProjectView — the focused screen shown for a project that has no
 * successful deployment yet (status: draft / failed / cancelled, i.e.
 * `activeDeploymentId == null`). The normal project dashboard assumes
 * analytics + an active deployment exist, so for a never-deployed project
 * it renders empty/broken; this replaces it with a purpose-built screen:
 *
 *   • a status hero with the primary "Deploy now" action
 *   • a two-column body: the full deploy-attempt history on the LEFT (each
 *     row opens that build directly at /build/{id} — no detour through the
 *     production deployments tab), and the source summary + danger zone
 *     stacked on the RIGHT.
 *
 * Everything a draft needs lives here — you never have to enter the
 * production tabbed UI while a project is still draft. The normal tabbed
 * dashboard returns automatically after the first successful deploy
 * (activeDeploymentId becomes non-null → status "live").
 *
 * Styling matches the rest of the project UI: `bg-card rounded-2xl border
 * border-border/50` cards, icon-in-rounded-box section headers, the shared
 * status pill (PROJECT_STATUS_META), and sidebar-style key/value rows.
 */

import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import {
  Rocket,
  Settings,
  Trash2,
  Github,
  FolderCode,
  AlertTriangle,
  Loader2,
  ListChecks,
  ChevronRight,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { projectsApi } from "@/lib/api";
import { getProjectStatus, PROJECT_STATUS_META, type ProjectStatus } from "@/utils/project-status";
import { encodeLocalSlug, encodeRepoSlug } from "@/utils/repoSlug";

interface DraftProjectViewProps {
  /** Deletes the project. Page passes its handleDeleteProject (defaults:
   *  deleteApp=true, wipeVolumes=false, force=false — correct for a draft
   *  with nothing provisioned). */
  onDeleteProject: () => void | Promise<void>;
}

interface AttemptRow {
  id: string;
  status: string;
  createdAt?: string;
  commitSha?: string;
  commitMessage?: string;
}

const ATTEMPT_STATUSES: ProjectStatus[] = [
  "failed",
  "cancelled",
  "building",
  "queued",
  "deploying",
  "live",
];

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function DraftProjectView({ onDeleteProject }: DraftProjectViewProps) {
  const { id, projectData, setActiveTab } = useProjectSettings();
  const router = useRouter();

  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const status = getProjectStatus(projectData);
  const meta = PROJECT_STATUS_META[status] ?? PROJECT_STATUS_META.draft;

  const hasRepoSource = Boolean(projectData?.gitOwner && projectData?.gitRepo);
  const hasLocalSource = Boolean(projectData?.localPath);
  const hasSource = hasRepoSource || hasLocalSource;

  // Load prior attempts (failed/cancelled). A pristine draft returns [] and
  // the section is omitted — the hero already says "not deployed yet".
  useEffect(() => {
    let cancelled = false;
    projectsApi
      .getDeployments(id)
      .then((res: unknown) => {
        if (cancelled) return;
        const list = Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? []);
        // Show the full history inline — the draft view is the ONLY place a
        // never-deployed project's builds are listed (no production tab here).
        setAttempts(list as AttemptRow[]);
      })
      .catch(() => {
        /* non-fatal — attempts section just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleDeploy = useCallback(() => {
    if (!projectData?.id) return;
    const params = new URLSearchParams({ projectId: projectData.id });
    if (hasRepoSource) {
      router.push(`/deploy/${encodeRepoSlug(projectData.gitOwner, projectData.gitRepo)}?${params}`);
      return;
    }
    if (hasLocalSource) {
      router.push(`/deploy/${encodeLocalSlug(projectData.localPath)}?${params}`);
      return;
    }
    setActiveTab("settings");
  }, [projectData, hasRepoSource, hasLocalSource, router, setActiveTab]);

  const heading =
    status === "failed"
      ? "Last deploy didn't finish"
      : status === "cancelled"
        ? "Deploy was cancelled"
        : "Ready to deploy";
  const subtext =
    status === "draft"
      ? "This project hasn't been deployed yet. Deploy it to get a live URL, logs, and analytics."
      : "This project has no live deployment yet. Review the source and try again.";

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await onDeleteProject();
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
      {/* ── LEFT COLUMN — status + deploy history ─────────────────── */}
      <div className="space-y-6 min-w-0">
        {/* Status hero */}
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                  Deployment
                </p>
                <h2 className="mt-1 text-lg font-semibold text-foreground">{heading}</h2>
                <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
                  {subtext}
                </p>
              </div>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.badge}`}
            >
              <span className={`size-1.5 rounded-full ${meta.dot}`} />
              {meta.label}
            </span>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              onClick={handleDeploy}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20"
            >
              <Rocket className="size-4" />
              {hasSource ? "Deploy now" : "Connect a source"}
            </button>
            <button
              onClick={() => setActiveTab("settings")}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <Settings className="size-4" />
              Settings
            </button>
          </div>
        </div>

        {/* Deploy attempts — full build history inline; click a row to open
            that build directly (no detour through the production UI). */}
        <SectionCard
          icon={ListChecks}
          title="Deploy attempts"
          description="Every build for this project — click one to open it"
        >
          {attempts.length > 0 ? (
            <div className="-mx-2 space-y-0.5">
              {attempts.map((d) => {
                const s = (ATTEMPT_STATUSES as string[]).includes(d.status)
                  ? (d.status as ProjectStatus)
                  : "draft";
                const am = PROJECT_STATUS_META[s];
                const commit = d.commitSha ? d.commitSha.slice(0, 7) : "";
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => router.push(`/build/${d.id}`)}
                    className="group flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-foreground/[0.05]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${am.badge}`}
                      >
                        <span className={`size-1.5 rounded-full ${am.dot}`} />
                        {am.label}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {commit && <span className="font-mono">{commit}</span>}
                        {commit && d.commitMessage ? "  ·  " : ""}
                        {d.commitMessage ?? ""}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-muted-foreground/70">
                        {relativeTime(d.createdAt)}
                      </span>
                      <ChevronRight className="size-4 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <div className="flex size-10 items-center justify-center rounded-xl bg-muted ring-1 ring-border/50">
                <ListChecks className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No deploy attempts yet</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Your build history appears here once you deploy — open any attempt to read its logs.
              </p>
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── RIGHT COLUMN — source + danger zone ───────────────────── */}
      <div className="space-y-6">
        <SectionCard
          icon={hasRepoSource ? Github : FolderCode}
          title="Source"
          description="Where this project deploys from"
        >
          {hasSource ? (
            <div className="space-y-3">
              {hasRepoSource && (
                <InfoRow label="Repository" value={`${projectData.gitOwner}/${projectData.gitRepo}`} />
              )}
              {hasRepoSource && projectData.gitBranch && (
                <InfoRow label="Branch" value={String(projectData.gitBranch)} />
              )}
              {hasLocalSource && <InfoRow label="Local path" value={String(projectData.localPath)} />}
              {projectData?.framework && (
                <InfoRow label="Framework" value={String(projectData.framework)} />
              )}
              {projectData?.options?.buildCommand && (
                <InfoRow
                  label="Build"
                  value={`${projectData.options.buildCommand}${projectData.options.outputDirectory ? ` → ${projectData.options.outputDirectory}` : ""}`}
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No source connected yet.{" "}
              <button
                onClick={() => setActiveTab("settings")}
                className="font-medium text-primary hover:underline"
              >
                Connect a repository or local path
              </button>
              .
            </p>
          )}
        </SectionCard>

        <SectionCard
          icon={AlertTriangle}
          title="Danger zone"
          description="Irreversible actions"
          tone="danger"
        >
          {!confirmOpen ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Delete this project. This can&apos;t be undone.
              </p>
              <button
                onClick={() => setConfirmOpen(true)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/30 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
              >
                <Trash2 className="size-4" />
                Delete project
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-foreground">
                Permanently delete <span className="font-medium">{projectData?.name}</span>?
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setConfirmOpen(false)}
                  disabled={deleting}
                  className="flex-1 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  Delete
                </button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/* ── Themed building blocks ─────────────────────────────────────── */

function SectionCard({
  icon: Icon,
  title,
  description,
  action,
  tone = "default",
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: "default" | "danger";
  children: React.ReactNode;
}) {
  const danger = tone === "danger";
  return (
    <div
      className={`bg-card rounded-2xl border ${danger ? "border-red-500/20" : "border-border/50"}`}
    >
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-xl ring-1 ${
            danger ? "bg-red-500/10 ring-red-500/15" : "bg-muted ring-border/50"
          }`}
        >
          <Icon className={`size-4 ${danger ? "text-red-500" : "text-muted-foreground"}`} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-medium text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}
