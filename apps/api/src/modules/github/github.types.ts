/**
 * GitHub types - shared interfaces for the entire GitHub module.
 */

// ─── GitHub API response shapes ──────────────────────────────────────────────

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  type: "User" | "Organization";
  name?: string;
  email?: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number; avatar_url: string };
  private: boolean;
  visibility: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  description: string | null;
  language: string | null;
  size: number;
  forks: number;
  watchers: number;
  stargazers_count: number;
  license: unknown;
  created_at: string;
  updated_at: string;
  pushed_at: string;
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string; url: string };
  protected: boolean;
}

export interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    id: number;
    avatar_url: string;
    type: "User" | "Organization";
  };
  app_id: number;
  target_type: string;
  permissions: Record<string, string>;
  events: string[];
}

export interface GitHubWebhook {
  id: number;
  active: boolean;
  events: string[];
  config: { url: string; content_type: string };
}

export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir";
  content?: string; // base64-encoded
  encoding?: string;
  download_url: string | null;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url: string;
}

export interface GitHubTreeResponse {
  sha: string;
  truncated: boolean;
  tree: GitHubTreeEntry[];
}

export interface GitHubCheckRun {
  id: number;
  status: string;
  conclusion: string | null;
}

// ─── Push webhook payload ────────────────────────────────────────────────────

export interface GitHubPushCommit {
  id: string;
  message: string;
  timestamp: string;
  url: string;
  author: { name: string; email: string; username?: string };
  committer: { name: string; email: string; username?: string };
  added: string[];
  removed: string[];
  modified: string[];
}

export interface GitHubPushPayload {
  ref: string;
  deleted?: boolean;
  head_commit: GitHubPushCommit | null;
  repository: {
    name: string;
    full_name: string;
    default_branch?: string;
    owner: { login: string; id: number };
  };
  sender: { id: number; login: string };
  hook_id?: number;
}

// ─── Installation webhook payload ────────────────────────────────────────────

export interface GitHubInstallationPayload {
  action: "created" | "deleted" | "suspend" | "unsuspend";
  installation: GitHubInstallation;
  sender: { id: number; login: string };
}

// ─── Mapped types for API responses ──────────────────────────────────────────

export interface MappedRepository {
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  html_url: string;
  private: boolean;
  visibility: string;
  default_branch: string;
  language: string | null;
  size: number;
  forks: number;
  watchers: number;
  stars: number;
  license: unknown;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /**
   * Where openship learned about this repo:
   *   - "app"  → covered by a GitHub App installation. Deployable anywhere
   *              (local + remote) via short-lived install tokens.
   *   - "cli"  → seen by the local `gh` CLI but NOT covered by an App
   *              installation. Deployable for LOCAL builds only; remote
   *              builds will be refused by clone-auth.
   *   - "both" → visible to both. Same capabilities as "app".
   *
   * Used by the dashboard repo picker to render a "Local builds only"
   * chip + install-App-on-this-owner prompt where appropriate.
   * Undefined for legacy code paths and SaaS mode (App is the only source).
   */
  source?: "app" | "cli" | "both";
}

export interface MappedAccount {
  login: string;
  id: number;
  avatar_url: string;
  type: string;
}

export interface RepositoryDetail {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  branches?: GitHubBranch[];
}
