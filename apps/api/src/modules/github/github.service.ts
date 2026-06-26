/**
 * GitHub service - business logic for repositories, branches, files, and webhooks.
 *
 * All GitHub API interactions go through `githubFetch` from github.auth,
 * keeping this module focused on data transformation and business rules.
 */

import { randomBytes } from "crypto";
import {
  githubFetch,
  getGitHubConnectionState,
  getUserStatus,
  getUserInstallations,
  getInstallationToken,
  resolveGitHubAuthMode,
  mapAccounts,
  getGitHubAuthMode,
} from "./github.auth";
import { ghFetch } from "./github.http";
import { listLocalGhRepos, listLocalGhOrgs, getLocalGhToken } from "./github.local-auth";
import { isIgnoredRepoPath } from "../../lib/project-root-detector";
import type { RequestContext } from "../../lib/request-context";
import { repos as dbRepos } from "@repo/db";
import { encrypt, decrypt } from "../../lib/encryption";
import type {
  GitHubRepository,
  GitHubBranch,
  GitHubFileContent,
  GitHubTreeResponse,
  GitHubWebhook,
  GitHubConnectionState,
  MappedRepository,
  MappedAccount,
  RepositoryDetail,
} from "./github.types";
import { env, runtimeTarget } from "../../config/env";

export const GITHUB_DEPLOY_WEBHOOK_EVENTS = ["push"] as const;
const MAX_FALLBACK_TREE_ENTRIES = 5000;

/**
 * Length in bytes of a per-project webhook signing secret. 32 raw bytes
 * (64 hex chars) is well over GitHub's documented minimum and matches
 * the entropy of the existing env.GITHUB_WEBHOOK_SECRET we generate
 * elsewhere. Keep this exported so the rotate helper and any future
 * callers don't redefine it.
 */
export const WEBHOOK_SECRET_BYTES = 32;

/**
 * OAuth scopes that strictly exceed Openship's needs and should warn a
 * user when present on a saved PAT. These are the broad, account- or
 * org-administrative scopes; possessing them does not break Openship,
 * but the dashboard's PAT save handler should surface a clear warning
 * so the user understands they handed us more access than necessary.
 *
 * Source: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 */
export const PAT_SCOPE_WARN_PATTERNS: readonly RegExp[] = [
  /^admin:/i,        // admin:org, admin:repo_hook, admin:public_key, …
  /^delete_repo$/i,
  /^write:packages$/i,
  /^write:org$/i,
];

/**
 * Scopes that are REQUIRED — at least one of these MUST be present on a
 * saved PAT. `repo` grants full private-repo read/write; `public_repo`
 * is the public-only subset. Without either we cannot clone or list any
 * non-public repo, so the dashboard's PAT save handler should hard-fail.
 */
export const PAT_SCOPE_REQUIRED: readonly string[] = ["repo", "public_repo"];

/**
 * Result of `inspectPatScope`.
 *
 *   - `scopes` is the validated list of OAuth scopes returned by GitHub
 *     (from the `x-oauth-scopes` response header). Empty when the token
 *     is a fine-grained PAT that doesn't expose classic scopes.
 *   - `user` is the GitHub login the token belongs to — useful for
 *     attribution and downstream "this PAT belongs to @x" UX.
 */
export interface PatScopeReport {
  scopes: string[];
  user: string;
}

/**
 * HIGH #10 — inspect a PAT before we accept and store it. Calls
 * `GET /user` with the proposed token and reads `x-oauth-scopes` from
 * the response header (the canonical place GitHub publishes the scope
 * set of a classic OAuth/PAT token; absent or empty for fine-grained
 * PATs, where scope is set via the repo permission model instead).
 *
 * Throws on any non-2xx — callers should map that to a clean "invalid
 * token" response. The returned `scopes` array is whitespace-split and
 * lowercased; the controller decides whether to:
 *   - REJECT outright (missing every PAT_SCOPE_REQUIRED entry),
 *   - WARN (any PAT_SCOPE_WARN_PATTERNS match), or
 *   - persist alongside `user_settings.patScope` for later re-validation.
 *
 * Lives in github.service.ts (not in lib/) because PAT inspection is
 * GitHub-specific and the constants above belong with it.
 */
export async function inspectPatScope(token: string): Promise<PatScopeReport> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Could not validate PAT (GitHub returned ${res.status}). ${body.slice(0, 200)}`,
    );
  }
  const scopeHeader = res.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopeHeader
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const json = (await res.json()) as { login?: string };
  return { scopes, user: json.login ?? "" };
}

/**
 * Convenience classifier for the inspectPatScope report. Centralizes
 * the policy so callers don't reimplement the rules independently.
 *
 * Returns:
 *   - `{ ok: false, reason }`  — token lacks every required scope; the
 *     caller MUST refuse to save it.
 *   - `{ ok: true, warning }`  — token includes a broader-than-needed
 *     scope; the caller SHOULD surface this back in the response body.
 *   - `{ ok: true }`           — token is fine.
 */
export function classifyPatScope(
  report: PatScopeReport,
):
  | { ok: false; reason: string }
  | { ok: true; warning?: string } {
  const scopeSet = new Set(report.scopes);

  // Fine-grained PATs report no classic scopes — pass without warning.
  // The GitHub API still gates each request by the repo permission grid,
  // so the token can't escalate beyond what the user explicitly granted.
  if (report.scopes.length === 0) return { ok: true };

  if (!PAT_SCOPE_REQUIRED.some((s) => scopeSet.has(s))) {
    return {
      ok: false,
      reason: `PAT is missing required scope (need one of: ${PAT_SCOPE_REQUIRED.join(", ")}). Got: ${report.scopes.join(", ") || "none"}.`,
    };
  }

  const broad = report.scopes.filter((s) =>
    PAT_SCOPE_WARN_PATTERNS.some((re) => re.test(s)),
  );
  if (broad.length > 0) {
    return {
      ok: true,
      warning: `PAT has broader scope than needed: ${broad.join(", ")}. Consider regenerating with only \`repo\` (or \`public_repo\`).`,
    };
  }
  return { ok: true };
}

async function listRepositoryTreeViaContents(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: { branch?: string } = {},
): Promise<Array<{ path: string; type: "file" | "dir" }>> {
  const tree: Array<{ path: string; type: "file" | "dir" }> = [];
  const visited = new Set<string>();
  const queue = [""];

  while (queue.length > 0) {
    const currentPath = queue.shift() ?? "";
    if (visited.has(currentPath) || isIgnoredRepoPath(currentPath)) {
      continue;
    }

    visited.add(currentPath);
    const entries = await listFiles(ctx, owner, repo, {
      ...opts,
      ...(currentPath ? { path: currentPath } : {}),
    }).catch(() => [] as GitHubFileContent[]);

    for (const entry of entries) {
      const entryType: "file" | "dir" = entry.type === "dir" ? "dir" : "file";
      tree.push({
        path: entry.path,
        type: entryType,
      });

      if (tree.length >= MAX_FALLBACK_TREE_ENTRIES) {
        return tree;
      }

      if (entry.type === "dir" && !isIgnoredRepoPath(entry.path)) {
        queue.push(entry.path);
      }
    }
  }

  return tree;
}

// ─── Repository mapping ─────────────────────────────────────────────────────

/**
 * Map raw GitHub API repos to a clean, consistent shape.
 */
export function mapRepositories(repos: GitHubRepository[]): MappedRepository[] {
  if (!Array.isArray(repos)) return [];

  return repos.map((r) => ({
    full_name: r.full_name,
    name: r.name,
    owner: r.owner?.login ?? r.full_name?.split("/")?.[0] ?? "",
    description: r.description,
    html_url: r.html_url,
    private: r.private,
    visibility: r.visibility,
    default_branch: r.default_branch,
    language: r.language,
    size: r.size,
    forks: r.forks,
    watchers: r.watchers,
    stars: r.stargazers_count ?? 0,
    license: r.license,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
  }));
}

// ─── Repository operations ───────────────────────────────────────────────────

/**
 * Fetch repos for a user/org via personal OAuth token (desktop/self-hosted mode).
 * Works without a GitHub App installation.
 */
export async function listUserOwnedRepos(
  ctx: RequestContext,
  owner?: string,
): Promise<MappedRepository[]> {
  if (!owner) {
    // User's own repos
    const data = await githubFetch<GitHubRepository[]>({
      ctx,
      url: "https://api.github.com/user/repos",
      params: { per_page: 100, sort: "updated", affiliation: "owner,collaborator,organization_member" },
    });
    return mapRepositories(Array.isArray(data) ? data : []);
  }

  // Org repos
  const data = await githubFetch<GitHubRepository[]>({
    ctx,
    url: `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`,
    params: { type: "all", per_page: 100 },
  });
  return mapRepositories(Array.isArray(data) ? data : []);
}

/**
 * Fetch repositories accessible through a specific GitHub App installation,
 * using the APP-INSTALLATION token against the install-scoped endpoint
 * /installation/repositories.
 *
 * Why the install token (NOT the user-OAuth /user/installations/{id}/repos
 * endpoint): on a self-hosted instance in cloud-app mode the user's GitHub
 * OAuth identity lives on the SaaS, NOT locally — so the old user-scoped call
 * resolved to NO local token (tokenFor → null) and threw "No GitHub access
 * token" on every home load, even though the App, the installations list, and
 * clone all work. The installation token IS available in both modes:
 * cloud-minted via the SaaS proxy in cloud-app (the same mint clone uses) or
 * local-minted with the App key in local-app mode.
 *
 * Authorization is enforced DOWNSTREAM: the controller filters this result
 * through the owner-grant access layer (filterAllowedRepos), so a member only
 * ever SEES the repos the owner granted them, regardless of what the
 * installation can technically access. The minted token is used server-side
 * to read the list and never leaves the process.
 */
export async function listInstallationRepos(
  ctx: RequestContext,
  owner: string,
  installationId?: number
): Promise<MappedRepository[]> {
  if (!installationId) return [];
  const token = await getInstallationToken(ctx, owner, installationId).catch(() => null);
  if (!token) return [];
  const data = await ghFetch<{ repositories: GitHubRepository[] }>(token, {
    url: "https://api.github.com/installation/repositories",
    params: { per_page: 100 },
  });
  return mapRepositories(data.repositories ?? []);
}

/**
 * Per-owner repo listing through the UNGATED local gh token — the gh-CLI
 * counterpart to the App-installation listing the controller uses. Reuses
 * listLocalGhRepos (the full affiliation list: owner + collaborator + org
 * member) and filters by owner. Consistent with getUserHome's gh-cli path,
 * and like it, deliberately bypasses tokenFor's operator-opt-in gate
 * (that gate guards REMOTE token-shipping, not local reads).
 *
 * Returns null when no gh token is available (no gh CLI, or CLOUD_MODE
 * where getLocalGhToken self-guards) so callers can distinguish "no gh
 * source here" (→ try another source / 400) from "gh source, owner has 0
 * repos" (→ empty array).
 */
export async function listGhCliReposForOwner(
  userId: string,
  owner?: string,
): Promise<MappedRepository[] | null> {
  const token = await getLocalGhToken();
  if (!token) return null;

  const ghRepos = await listLocalGhRepos(userId);
  const mapped = mapRepositories(
    Array.isArray(ghRepos) ? (ghRepos as GitHubRepository[]) : [],
  );
  if (!owner) return mapped;

  const target = owner.toLowerCase();
  return mapped.filter(
    (r) => (r.full_name.split("/")[0] ?? "").toLowerCase() === target,
  );
}

/**
 * The resolved GitHub source for a per-owner repo LISTING, computed ONCE so
 * every listing entry point (the /repos and /orgs/:org/repos controllers)
 * dispatches the same way instead of each re-deriving "App vs gh-cli vs
 * user-token" from mode + status. Mirrors the historical controller gate
 * cell-for-cell (no extra SaaS round-trip; deliberately does NOT call the
 * heavier getGitHubConnectionState):
 *
 *   - non App/cloud-app mode (cli/oauth/token) → "user-token" (/user or /orgs)
 *   - App/cloud-app + SaaS GitHub connected     → "installations"
 *   - App/cloud-app + NOT connected             → "gh-cli" fallback
 *     (listGhCliReposForOwner returns null when no gh token → surfaces as 400,
 *     same as before; this is the cloud-app-without-SaaS-GitHub case)
 *
 * NOTE: getUserHome deliberately does NOT use this — it dispatches on
 * state.primary and MERGES App + gh-cli repos with source tagging, a richer
 * view than a single source.
 */
type ListingSource =
  | { kind: "installations"; status: Awaited<ReturnType<typeof getUserStatus>> }
  | { kind: "user-token"; status: Awaited<ReturnType<typeof getUserStatus>> }
  | { kind: "gh-cli" };

async function resolveListingSource(ctx: RequestContext): Promise<ListingSource> {
  const mode = await resolveGitHubAuthMode(ctx);
  if (mode !== "app" && mode !== "cloud-app") {
    return { kind: "user-token", status: await getUserStatus(ctx.userId) };
  }
  const status = await getUserStatus(ctx.userId);
  if (status.connected) return { kind: "installations", status };
  // App/cloud-app mode but SaaS GitHub not connected → gh-cli fallback.
  // listGhCliReposForOwner returns null when no gh token is available, which
  // the caller surfaces as the 400 ("no usable GitHub source").
  return { kind: "gh-cli" };
}

/**
 * THE single "list repos for an owner" entry point — one place decides the
 * source and calls the matching primitive, so the controllers don't each
 * re-branch on mode/status. `owner` omitted = the user's own repos.
 *
 * Returns null ONLY when there is genuinely no usable GitHub source (the
 * caller maps that to a 400) — distinct from an empty array (source exists,
 * owner just has no matching repos).
 */
export async function listReposForOwner(
  ctx: RequestContext,
  owner?: string,
): Promise<MappedRepository[] | null> {
  const source = await resolveListingSource(ctx);

  switch (source.kind) {
    case "user-token": {
      // If the owner is the authenticated user, fetch their own repos
      // (/user/repos) — /orgs/{me}/repos would 404 for a user account.
      const isOwnAccount =
        owner && source.status.connected && owner === source.status.login;
      return listUserOwnedRepos(ctx, isOwnAccount ? undefined : owner);
    }

    case "installations": {
      if (!owner) {
        const installations = await getUserInstallations(ctx, source.status);
        if (installations.length === 0) return null;
        return listInstallationRepos(
          ctx,
          installations[0].account.login,
          installations[0].id,
        );
      }
      return listInstallationRepos(ctx, owner, undefined);
    }

    case "gh-cli":
      // null (no gh token) propagates to the caller's 400.
      return listGhCliReposForOwner(ctx.userId, owner);
  }
}

/**
 * Get a single repository, optionally with branches.
 */
export async function getRepository(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: { withBranches?: boolean } = {},
): Promise<RepositoryDetail> {
  const data = await githubFetch<GitHubRepository>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  });

  let branches: GitHubBranch[] | undefined;
  if (opts.withBranches) {
    branches = await listBranches(ctx, owner, repo);
  }

  return {
    id: data.id,
    name: data.name,
    full_name: data.full_name,
    owner: data.owner?.login ?? owner,
    private: data.private,
    default_branch: data.default_branch,
    clone_url: data.clone_url,
    ssh_url: data.ssh_url,
    html_url: data.html_url,
    branches,
  };
}

/**
 * Create a new repository (user or org).
 */
export async function createRepository(
  ctx: RequestContext,
  name: string,
  opts: { description?: string; private?: boolean; owner?: string; } = {},
): Promise<GitHubRepository> {
  const url = opts.owner
    ? `https://api.github.com/orgs/${encodeURIComponent(opts.owner)}/repos`
    : "https://api.github.com/user/repos";

  return githubFetch<GitHubRepository>({
    ctx,
    url,
    method: "POST",
    owner: opts.owner,
    params: {
      name,
      description: opts.description ?? `Repository created by Openship`,
      private: opts.private ?? false,
    },
  });
}

/**
 * Delete a repository (requires admin permissions).
 */
export async function deleteRepository(
  ctx: RequestContext,
  owner: string,
  repo: string
): Promise<void> {
  await githubFetch({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    method: "DELETE",
  });
}

// ─── Branches ────────────────────────────────────────────────────────────────

/**
 * List branches for a repository.
 */
export async function listBranches(
  ctx: RequestContext,
  owner: string,
  repo: string
): Promise<GitHubBranch[]> {
  return githubFetch<GitHubBranch[]>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    params: { per_page: 100 },
  });
}

/**
 * Get the latest commit on a branch.
 */
export async function getLatestCommit(
  ctx: RequestContext,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ sha: string; message: string } | null> {
  try {
    const data = await githubFetch<{ sha: string; commit: { message: string } }>({
      ctx,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
    });
    return { sha: data.sha, message: data.commit.message };
  } catch {
    return null;
  }
}

/**
 * Fetch recent commits from a branch via the GitHub API.
 */
export async function getRecentCommits(
  ctx: RequestContext,
  owner: string,
  repo: string,
  branch: string,
  perPage = 10,
): Promise<Array<{
  sha: string;
  message: string;
  author: string;
  authorAvatar: string;
  date: string;
  url: string;
}>> {
  try {
    const data = await githubFetch<Array<{
      sha: string;
      html_url: string;
      commit: {
        message: string;
        author: { name: string; date: string } | null;
      };
      author: { login: string; avatar_url: string } | null;
    }>>({
      ctx,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      params: { sha: branch, per_page: String(perPage) },
    });

    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.author?.login ?? c.commit.author?.name ?? "Unknown",
      authorAvatar: c.author?.avatar_url ?? "",
      date: c.commit.author?.date ?? "",
      url: c.html_url,
    }));
  } catch {
    return [];
  }
}

/**
 * Compare two commits and return the unioned list of changed file paths.
 *
 * Webhook callers fall back to this when a push event lists exactly 20
 * commits (GitHub truncates `commits[]` to 20 per push, so anything ≥ 20
 * may have omitted some) and they need the FULL changed-files set for
 * smart per-service routing.
 *
 * Returns `null` on any API error so callers can degrade to the truncated
 * commits[] list rather than failing the deploy.
 */
export async function compareCommits(
  ctx: RequestContext,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<{ files: string[] } | null> {
  try {
    const data = await githubFetch<{
      files?: Array<{ filename: string; previous_filename?: string }>;
    }>({
      ctx,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    });
    const out = new Set<string>();
    for (const f of data.files ?? []) {
      if (f.filename) out.add(f.filename);
      if (f.previous_filename) out.add(f.previous_filename);
    }
    return { files: Array.from(out) };
  } catch {
    return null;
  }
}

// ─── Files ───────────────────────────────────────────────────────────────────

/**
 * List files in a repository directory.
 */
export async function listFiles(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: { branch?: string; path?: string; } = {},
): Promise<GitHubFileContent[]> {
  const filePath = opts.path ?? "";
  return githubFetch<GitHubFileContent[]>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`,
    params: opts.branch ? { ref: opts.branch } : undefined,
  });
}

/**
 * List the full repository tree recursively.
 */
export async function listRepositoryTree(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: { branch?: string } = {},
): Promise<Array<{ path: string; type: "file" | "dir" }>> {
  const ref = opts.branch?.trim() || "HEAD";
  const data = await githubFetch<GitHubTreeResponse>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}`,
    params: { recursive: 1 },
  });

  const tree: Array<{ path: string; type: "file" | "dir" }> = (data.tree ?? [])
    .filter((entry) => entry.type === "blob" || entry.type === "tree")
    .map((entry) => ({
      path: entry.path,
      type: entry.type === "tree" ? "dir" : "file",
    }));

  if (!data.truncated) {
    return tree;
  }

  const fallbackTree = await listRepositoryTreeViaContents(ctx, owner, repo, opts).catch(() => tree);
  return fallbackTree.length > 0 ? fallbackTree : tree;
}

/**
 * Get a single file's content (decoded from base64).
 */
export async function getFileContent(
  ctx: RequestContext,
  owner: string,
  repo: string,
  file: string,
  opts: { branch?: string; json?: boolean; } = {},
): Promise<{
  sha: string;
  size: number;
  content: string;
  download_url: string | null;
}> {
  const data = await githubFetch<GitHubFileContent>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file}`,
    params: opts.branch ? { ref: opts.branch } : undefined,
  });

  let content = Buffer.from(data.content ?? "", "base64").toString("utf-8");

  if (opts.json) {
    try {
      content = JSON.parse(content);
    } catch {
      /* return raw string if not valid JSON */
    }
  }

  return {
    sha: data.sha,
    size: data.size,
    content: typeof content === "string" ? content : JSON.stringify(content),
    download_url: data.download_url,
  };
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/**
 * List webhooks for a repository.
 */
export async function listWebhooks(
  ctx: RequestContext,
  owner: string,
  repo: string
): Promise<GitHubWebhook[]> {
  return githubFetch<GitHubWebhook[]>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
  });
}

function normalizeWebhookUrl(url?: string | null): string {
  return (url ?? "").replace(/\/+$/, "");
}

/**
 * Create a deploy webhook for a repository.
 */
export async function createWebhook(
  ctx: RequestContext,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret?: string,
): Promise<{ hookId: number; events: string[]; active: boolean }> {
  const config: Record<string, unknown> = {
    url: webhookUrl,
    content_type: "json",
  };
  if (secret) config.secret = secret;

  const data = await githubFetch<GitHubWebhook>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    method: "POST",
    params: {
      name: "web",
      active: true,
      events: [...GITHUB_DEPLOY_WEBHOOK_EVENTS],
      config,
    },
  });

  return { hookId: data.id, events: data.events, active: data.active };
}

/**
 * Update a webhook (e.g. toggle active state).
 */
export async function updateWebhook(
  ctx: RequestContext,
  owner: string,
  repo: string,
  hookId: number,
  patch: {
    active?: boolean;
    events?: string[];
    config?: Record<string, unknown>;
  },
): Promise<{ id: number; active: boolean; events: string[] }> {
  const data = await githubFetch<GitHubWebhook>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`,
    method: "PATCH",
    params: patch,
  });
  return { id: data.id, active: data.active, events: data.events };
}

/**
 * Delete a webhook from a repository.
 */
export async function deleteWebhook(
  ctx: RequestContext,
  owner: string,
  repo: string,
  hookId: number
): Promise<void> {
  await githubFetch({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`,
    method: "DELETE",
  });
}

// ─── Check runs ──────────────────────────────────────────────────────────────

/**
 * Create a GitHub check run (used to report deployment status).
 */
export async function createCheckRun(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: {
    name: string;
    headSha: string;
    status: "queued" | "in_progress" | "completed";
    /** Conclusion is only valid when status === "completed". */
    conclusion?: "success" | "failure" | "cancelled" | "neutral" | "skipped";
    detailsUrl?: string;
    output?: { title: string; summary: string; text?: string };
  },
): Promise<{ id: number; htmlUrl?: string } | null> {
  try {
    const data = await githubFetch<{ id: number; html_url?: string }>({
      ctx,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
      method: "POST",
      params: {
        name: opts.name,
        head_sha: opts.headSha,
        status: opts.status,
        started_at: new Date().toISOString(),
        ...(opts.status === "completed"
          ? { completed_at: new Date().toISOString(), conclusion: opts.conclusion }
          : {}),
        details_url: opts.detailsUrl,
        output: opts.output,
      },
    });
    return { id: data.id, htmlUrl: data.html_url };
  } catch {
    return null;
  }
}

/**
 * Update an existing check run (e.g. mark as completed).
 */
export async function updateCheckRun(
  ctx: RequestContext,
  owner: string,
  repo: string,
  checkRunId: number,
  opts: {
    status: "completed";
    conclusion: "success" | "failure" | "cancelled" | "neutral" | "skipped";
    output?: { title: string; summary: string; text?: string };
  },
): Promise<void> {
  try {
    await githubFetch({
      ctx,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}`,
      method: "PATCH",
      params: {
        status: opts.status,
        completed_at: new Date().toISOString(),
        conclusion: opts.conclusion,
        ...(opts.output ? { output: opts.output } : {}),
      },
    });
  } catch {
    /* best-effort - don't fail the deployment if check update fails */
  }
}

// ─── User organisations ──────────────────────────────────────────────────────

/**
 * Check whether the user has a default clone token configured.
 *
 * "Default" here = `user_settings.clone_token_encrypted IS NOT NULL
 * AND clone_token_as_default = true`. We don't need to DECRYPT the
 * token — just confirm it exists and is marked default. A configured
 * default clone token means the user has opted in to using it for any
 * repo they can see, so "Local only" badging is misleading for those
 * users (the token covers it). One DB read, no per-repo cost.
 */
async function userHasDefaultCloneToken(userId: string): Promise<boolean> {
  const settings = await dbRepos.settings.findByUser(userId).catch(() => null);
  return !!(settings?.cloneTokenEncrypted && settings.cloneTokenAsDefault);
}

/**
 * SOURCE OF TRUTH for the "Local only" badge.
 *
 * Returns true ONLY when all of these are true:
 *   - The repo is private (public repos clone anonymously — no badge)
 *   - The user has NO default clone token (a clone token works for any
 *     visible repo, regardless of App coverage)
 *   - The Openship App is connected at all (if not, the page-level
 *     "Install App" banner is the right place to surface the gap —
 *     don't badge every single repo)
 *   - The repo's owner has NO App installation (if they do, the App
 *     can mint an install token for the repo, no badge needed)
 *
 * Client never duplicates this logic. It just reads `repo.source`.
 */
function shouldTagLocalOnly(args: {
  repo: { private: boolean; owner: string };
  appInstalledOwners: Set<string>;
  hasUserCloneToken: boolean;
  appConnected: boolean;
}): boolean {
  if (!args.repo.private) return false;
  if (args.hasUserCloneToken) return false;
  if (!args.appConnected) return false;
  if (args.appInstalledOwners.has(args.repo.owner.toLowerCase())) return false;
  return true;
}

/**
 * Get the user's "home" view — the canonical connection state, plus the
 * accounts and repos visible from the active source(s).
 *
 * Shape (the ONLY wire shape callers see):
 *   {
 *     state: GitHubConnectionState,   // sources + primary
 *     accounts: MappedAccount[],
 *     repos: MappedRepository[],
 *   }
 *
 * `state` is the single source of truth — see getGitHubConnectionState.
 * Listings + repos come from `state.primary`:
 *   - "openship-app" → /installations + per-install repos (merged with
 *     gh CLI repos if available, so personal forks the App isn't on
 *     still show up — clone-auth refuses them for remote builds).
 *   - "gh-cli"       → /user/repos + /user/orgs via the CLI token.
 *   - null           → empty arrays.
 */
export async function getUserHome(ctx: RequestContext): Promise<{
  state: GitHubConnectionState;
  accounts: MappedAccount[];
  repos: MappedRepository[];
  errors?: Record<string, string>;
}> {
  const userId = ctx.userId;
  const state = await getGitHubConnectionState(ctx);
  const errors: Record<string, string> = {};

  // Nothing connected → return the empty shell. The dashboard renders
  // the connect prompt when state.primary === null.
  if (state.primary === null) {
    return { state, accounts: [], repos: [] };
  }

  // ── Openship App path ──────────────────────────────────────────────
  // Used whenever the App is connected. Installation-scoped tokens are
  // the safest source and produce the canonical account list.
  if (state.primary === "openship-app") {
    let accounts: MappedAccount[] = [];
    let repos: MappedRepository[] = [];
    /**
     * Set of owner logins (lowercased) that have ANY App installation.
     * Used when merging gh CLI repos so a CLI repo whose owner has an
     * App installation does NOT get a misleading "Local only" badge,
     * even though we haven't fetched that secondary install's repo list
     * yet (we don't fan out — that would overload the API on first
     * load with N parallel calls).
     *
     * Trade-off: this is owner-level granularity, not repo-level.
     * A repo-scoped installation (App granted access to only specific
     * repos under an org) will still trigger a misleading "covered"
     * tag here for repos under that org that the install can't actually
     * touch. Clone-auth will refuse those at deploy time with a clear
     * error — much better than every CLI repo flashing "Local only"
     * on every page load.
     */
    const appInstalledOwners = new Set<string>();
    // HIGH #1: track whether the App lookup itself succeeded. The previous
    // code passed a hardcoded `appConnected: true` to shouldTagLocalOnly
    // for every CLI-side repo even when getUserInstallations threw — the
    // owners set stayed empty AND the rule was told "App is connected",
    // so every CLI repo got falsely badged "Local only". Set this to
    // false when the App lookup fails: shouldTagLocalOnly short-circuits
    // to false (no badge), which matches the page-level "Install App"
    // CTA the dashboard surfaces in that exact state.
    let appAvailable = false;

    try {
      const status = await getUserStatus(userId);
      const installations = await getUserInstallations(ctx, status);
      appAvailable = true;
      // Tag every App installation account with source: "app" so the
      // dashboard can distinguish them from any CLI-side accounts that
      // get merged in later. Without this tag the settings card would
      // (and did) render CLI org memberships as if they were App
      // installations — see GitHubConnection.tsx where appAccounts
      // gates rendering on state.sources.openshipApp.connected.
      accounts = mapAccounts(installations).map((acct) => ({ ...acct, source: "app" as const }));
      for (const i of installations) {
        appInstalledOwners.add(i.account.login.toLowerCase());
      }

      if (installations.length > 0) {
        const primaryInstall =
          installations.find((i) => i.account.login === status.login) ??
          installations[0];

        // Only the PRIMARY install's repos are fetched up-front for the
        // initial visible list. Other accounts load their repos when
        // the user clicks them in the picker via fetchReposForOwner.
        repos = await listInstallationRepos(
          ctx,
          primaryInstall.account.login,
          primaryInstall.id,
        );
        for (const repo of repos) repo.source = "app";
      }
    } catch (err) {
      const message = (err as Error).message;
      // The most common case here is a fresh user whose OAuth token
      // doesn't yet have access to any installation repos — GitHub
      // responds 403 "must authenticate with an access token …". That
      // is the EXPECTED state when the user hasn't completed the App
      // install on any account yet; the dashboard renders the "Install
      // GitHub App" CTA via the install-url fallback below.
      //
      // DO NOT surface this as a server-side error to the dashboard —
      // the client iterates `errors` and toasts each entry, which would
      // spam "App path: 403 …" on every page load for an un-installed
      // user. Only put GENUINE failures (network, App auth, unknown
      // GitHub error) in the errors envelope.
      const isExpectedNoInstall =
        /403/.test(message) && /must authenticate with an access token/i.test(message);
      if (isExpectedNoInstall) {
        console.log("[GitHub] App path skipped: no installation visible to user yet (will show install CTA)");
      } else {
        console.warn("[GitHub] App path failed:", message);
        errors.app = message;
      }
      // appAvailable stays false — downstream rules must not assume
      // App coverage when we couldn't even read the install list.
    }

    // Merge gh CLI repos when available (self-hosted + cloud-connected
    // case). The `source: "cli"` tag means "Local only" in the dashboard,
    // so the rule is precise about when to apply it. SOURCE OF TRUTH for
    // "is this repo Local only?" lives entirely server-side — the client
    // just reads `repo.source`. See shouldTagLocalOnly() for the rule set.
    //
    // Pre-fetch the user's clone-token default ONCE (no per-repo DB hit),
    // so the rule can be evaluated in O(1) per repo.
    const hasUserCloneToken = await userHasDefaultCloneToken(userId);

    if (state.sources.ghCli.available) {
      try {
        const ghRepos = await listLocalGhRepos(userId);
        const byFullName = new Map(repos.map((r) => [r.full_name.toLowerCase(), r]));
        const mappedGh = mapRepositories(
          Array.isArray(ghRepos) ? (ghRepos as GitHubRepository[]) : [],
        );
        for (const r of mappedGh) {
          const key = r.full_name.toLowerCase();
          const existing = byFullName.get(key);
          if (existing) {
            // Visible from both sources — App-covered, no "Local only" badge.
            existing.source = "both";
          } else if (
            !shouldTagLocalOnly({
              repo: r,
              appInstalledOwners,
              hasUserCloneToken,
              // HIGH #1: honor the real App-availability signal. Pre-fix
              // this was hardcoded `true`, so even when the App lookup
              // threw we badged every CLI-only repo as "Local only".
              appConnected: appAvailable,
            })
          ) {
            // CLI-only but the rules say "don't badge" — covered by some
            // other path (public, clone token, owner has install).
            byFullName.set(key, { ...r, source: "both" });
          } else {
            byFullName.set(key, { ...r, source: "cli" });
          }
        }
        repos = Array.from(byFullName.values());
      } catch (err) {
        const message = (err as Error).message;
        console.warn("[GitHub] CLI repo merge failed:", message);
        errors.cli = message;
      }
    }

    return {
      state,
      accounts,
      repos,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    };
  }

  // ── gh CLI path ────────────────────────────────────────────────────
  // state.primary === "gh-cli". The App isn't connected; listings flow
  // through the user OAuth token (which tokenFor resolves to the
  // gh CLI fallback in this case).
  //
  // Per the source-of-truth rule in shouldTagLocalOnly(): when the App
  // is not connected at all, individual repos do NOT get a "Local only"
  // badge — the page-level "Install GitHub App" banner is the right
  // place to surface that gap. Badging every single row would be noise.
  // We leave `source` undefined so the dashboard renders a clean list.
  // Use the gh token DIRECTLY (listLocalGhRepos), not githubFetch → tokenFor.
  // tokenFor gates the CLI token behind the operator opt-in (a REMOTE-deploy
  // safety), which would refuse it here and surface a bogus "No GitHub access
  // token" even though gh CLI is the active source. Listing is a local read,
  // so it bypasses that gate — consistent with getGitHubConnectionState's
  // "if gh CLI is logged in, use it as the source of truth" rule.
  const ghRepos = await listLocalGhRepos(userId);
  const repos: MappedRepository[] = mapRepositories(
    Array.isArray(ghRepos) ? (ghRepos as GitHubRepository[]) : [],
  );
  // No per-repo source tag — App is unavailable, so a badge would be redundant
  // with the page-level connect-the-App prompt.

  // Build account list from /user + /user/orgs using the same token.
  // Every account on this path is tagged source: "cli" — they're CLI
  // org memberships, NOT GitHub App installations. The library page
  // uses this list to populate the owner picker (still useful for
  // browsing repos) but the settings GitHub card refuses to render
  // them as App installations because of the source tag + the
  // appConnected gate in GitHubConnection.tsx.
  const cliLogin = state.sources.ghCli.login;
  const cliAvatar = state.sources.ghCli.avatarUrl;
  const accounts: MappedAccount[] = cliLogin
    ? [{ login: cliLogin, id: 0, avatar_url: cliAvatar ?? "", type: "User", source: "cli" }]
    : [];
  // Ungated direct gh-token call (see listLocalGhRepos rationale above).
  const orgs = await listLocalGhOrgs(userId);
  for (const org of orgs) {
    accounts.push({
      login: org.login,
      id: org.id,
      avatar_url: org.avatar_url,
      type: "Organization",
      source: "cli",
    });
  }

  return {
    state,
    accounts,
    repos,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  };
}

// ─── Webhook strategy ────────────────────────────────────────────────────────

export type WebhookStrategy = "app" | "domain" | "repo" | "none";

/**
 * Determine the base webhook strategy from global config (sync, no user context).
 *
 *  - "app"  → GitHub App handles push events natively (cloud mode).
 *  - "repo" → Create per-repo webhooks (self-hosted with a public URL).
 *  - "none" → Can't receive webhooks (localhost / private IP).
 */
export function getWebhookStrategy(): WebhookStrategy {
  if (getGitHubAuthMode() === "app") return "app";

  // For non-app modes, check if the URL is publicly reachable
  const url = runtimeTarget.api;
  if (isLocalUrl(url)) return "none";
  return "repo";
}

/**
 * Resolve the effective webhook strategy for a project + user (async).
 *
 * Priority:
 *   1. "app"    - GitHub App (cloud mode)
 *   2. "domain" - project has a webhookDomain set (direct delivery)
 *   3. "repo"   - current API target is public
 *   4. "none"   - no way to receive webhooks
 */
export async function resolveWebhookStrategy(
  project?: { webhookDomain?: string | null },
): Promise<WebhookStrategy> {
  const base = getWebhookStrategy();
  if (base === "app") return "app";

  // Project has a domain configured → direct webhook delivery
  if (project?.webhookDomain) return "domain";

  // Public API target → repo-level webhooks
  if (base === "repo") return "repo";

  return "none";
}

/**
 * Get the list of available webhook strategies for a user + project.
 * Used by the dashboard to show options to the user.
 */
export async function getAvailableStrategies(
  ctx: RequestContext,
  project?: { webhookDomain?: string | null },
): Promise<{ current: WebhookStrategy; available: WebhookStrategy[] }> {
  const current = await resolveWebhookStrategy(project);
  const available: WebhookStrategy[] = [];

  if (getGitHubAuthMode() === "app") {
    available.push("app");
    return { current, available };
  }

  // Domain is always available if verified domains exist (handled by UI)
  available.push("domain");

  if (!isLocalUrl(runtimeTarget.api)) {
    available.push("repo");
  }

  return { current, available };
}

/**
 * True when the URL points to a host that is NOT reachable from the
 * public internet — so GitHub's webhook delivery would fail.
 *
 * Used to decide between webhook strategies in resolveWebhookStrategy:
 *   - reachable → "repo" (per-repo webhook directly to this URL)
 *   - unreachable → "none" (caller falls back to polling or domain
 *     delivery via the project's webhookDomain)
 *
 * Conservative on parse failure (returns true). A typo'd URL is safer
 * to assume unreachable than to register a webhook GitHub will never
 * be able to deliver to.
 *
 * Covers the full set of non-routable host shapes:
 *   - DNS sentinels: localhost, *.local (mDNS)
 *   - IPv4 loopback: 127.0.0.0/8 (ALL of 127, not just .0.1)
 *   - IPv4 unspecified: 0.0.0.0
 *   - IPv4 RFC1918 private: 10/8, 172.16/12, 192.168/16
 *   - IPv4 link-local / APIPA: 169.254.0.0/16
 *   - IPv6 loopback: ::1 (with optional [::1] bracket form)
 *   - IPv6 link-local: fe80::/10
 *   - IPv6 ULA: fc00::/7 (fc/fd prefix)
 */
function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return true;

    // DNS sentinel cases. `.local` is mDNS (Bonjour) — reachable only on
    // the local link, never from the public internet.
    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local")
    ) {
      return true;
    }

    // IPv6 (URL parses bracketed form; strip the brackets for matching).
    // Same hostname can also arrive un-bracketed if the caller passed a
    // bare IP. fe80::/10 → fe80..febf (first byte top 10 bits); fc00::/7
    // → fc00..fdff (first byte top 7 bits, fc or fd).
    const v6 = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    if (v6 === "::1") return true;
    if (/^fe[89ab][0-9a-f]?:/i.test(v6)) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true; // ULA

    // IPv4: full 127/8 + 0/8-sentinel handled above + RFC1918 + link-local.
    // (Not collapsed into a single regex — readability beats brevity here,
    // and each /8|/12|/16 has a different intent that benefits from being
    // named in the source.)
    if (/^127\./.test(hostname)) return true;                       // loopback /8
    if (/^10\./.test(hostname)) return true;                        // RFC1918 /8
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;   // RFC1918 /12
    if (/^192\.168\./.test(hostname)) return true;                  // RFC1918 /16
    if (/^169\.254\./.test(hostname)) return true;                  // link-local /16

    return false;
  } catch {
    return true;
  }
}

// ─── Webhook registration ────────────────────────────────────────────────────

/**
 * Mint a fresh webhook signing secret for a project. Single source of
 * truth so registration and rotation pick the same generator. Returns
 * the raw secret (which goes to GitHub) — the caller MUST encrypt
 * before persisting to the project row.
 */
export function mintWebhookSecret(): string {
  return randomBytes(WEBHOOK_SECRET_BYTES).toString("hex");
}

/**
 * Persist a freshly-minted webhook secret on the project row, encrypted
 * via the standard lib/encryption helper. Used by both registerWebhook
 * (first-time registration) and rotateProjectWebhookSecret (operator-
 * initiated rotation).
 */
async function persistProjectWebhookSecret(
  projectId: string,
  secret: string,
): Promise<void> {
  await dbRepos.project.update(projectId, {
    webhookSecret: encrypt(secret),
  });
}

/**
 * Resolve the signing secret for a project. Decrypts the per-project
 * value when present; falls back to env.GITHUB_WEBHOOK_SECRET for
 * legacy webhooks registered before per-project secrets existed.
 *
 * Returns null when neither is configured — the caller (webhook
 * verifier) is then on the self-hosted "unsigned webhooks allowed
 * during setup" path.
 */
export function resolveProjectWebhookSecret(
  project: { webhookSecret?: string | null } | null | undefined,
): string | null {
  if (project?.webhookSecret) {
    try {
      return decrypt(project.webhookSecret);
    } catch {
      // Encryption key rotation / corrupted row — fall through to env
      // rather than silently rejecting every webhook for this project.
      console.warn(
        "[GitHub Webhook] project.webhookSecret failed to decrypt; falling back to env.GITHUB_WEBHOOK_SECRET",
      );
    }
  }
  return env.GITHUB_WEBHOOK_SECRET || null;
}

/**
 * Register a deploy webhook on a repo.
 * If creation returns 422 (already exists), finds the existing hook.
 *
 * Callers should check `getWebhookStrategy()` before calling - this will
 * throw if the URL is unreachable (localhost).
 *
 * HIGH #9 — when a `projectId` is supplied, this generates a FRESH
 * webhook secret, sends it to GitHub in the hook config, and persists
 * the encrypted value on the project row. Each project gets its own
 * secret so a leak (or rotation of one) doesn't compromise others.
 * Without `projectId` we fall back to env.GITHUB_WEBHOOK_SECRET — used
 * by the legacy /github/repos/:owner/:repo/webhooks endpoint that
 * isn't tied to a project.
 */
export async function registerWebhook(
  ctx: RequestContext,
  owner: string,
  repo: string,
  webhookUrl = `${runtimeTarget.api}/api/webhooks/github`,
  opts: { projectId?: string } = {},
): Promise<{ hookId: number | null; events: string[] }> {
  // Per-project secret takes precedence; env stays the back-compat
  // fallback for callers without a project context.
  const secret = opts.projectId
    ? mintWebhookSecret()
    : env.GITHUB_WEBHOOK_SECRET || undefined;

  try {
    const result = await createWebhook(
      ctx,
      owner,
      repo,
      webhookUrl,
      secret || undefined,
    );
    if (opts.projectId && secret) {
      await persistProjectWebhookSecret(opts.projectId, secret);
    }
    return { hookId: result.hookId, events: result.events };
  } catch (err) {
    /* 422 = webhook already exists - find it */
    if (err instanceof Error && err.message.includes("422")) {
      const existing = await listWebhooks(ctx, owner, repo);
      const targetUrl = normalizeWebhookUrl(webhookUrl);
      const match = existing.find((h) =>
        normalizeWebhookUrl(h.config?.url) === targetUrl,
      );
      if (!match) return { hookId: null, events: [] };

      const config = secret
        ? {
            url: webhookUrl,
            content_type: "json",
            secret,
          }
        : undefined;
      const updated = await updateWebhook(ctx, owner, repo, match.id, {
        active: true,
        events: [...GITHUB_DEPLOY_WEBHOOK_EVENTS],
        config,
      });
      // We sent a new secret to GitHub on the update path — persist it
      // locally so the verifier matches. (If we kept the OLD GitHub-
      // side secret and only stored the new one locally, every future
      // delivery would fail HMAC verify until GitHub re-rotated.)
      if (opts.projectId && secret) {
        await persistProjectWebhookSecret(opts.projectId, secret);
      }
      return { hookId: updated.id, events: updated.events };
    }
    throw err;
  }
}

/**
 * Rotate the webhook signing secret for a project. Mints a new secret,
 * pushes it to GitHub via PATCH /repos/:owner/:repo/hooks/:hookId, and
 * persists the encrypted value on the project row. Idempotent at the
 * GitHub side — the hook keeps its id, only the secret changes.
 *
 * Throws if the project row can't be found or doesn't have a registered
 * webhook yet (caller should run registerWebhook first).
 */
export async function rotateProjectWebhookSecret(
  ctx: RequestContext,
  projectId: string,
): Promise<{ rotated: true; hookId: number }> {
  const project = await dbRepos.project.findById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  if (!project.webhookId || !project.gitOwner || !project.gitRepo) {
    throw new Error(
      `Project ${projectId} has no registered webhook to rotate — register one first.`,
    );
  }

  const fresh = mintWebhookSecret();
  const webhookUrl = `${runtimeTarget.api}/api/webhooks/github`;
  await updateWebhook(ctx, project.gitOwner, project.gitRepo, project.webhookId, {
    active: true,
    events: [...GITHUB_DEPLOY_WEBHOOK_EVENTS],
    config: { url: webhookUrl, content_type: "json", secret: fresh },
  });
  await persistProjectWebhookSecret(projectId, fresh);
  return { rotated: true, hookId: project.webhookId };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract owner and repo from a GitHub URL.
 */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const parts = repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").split("/");
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}
