/**
 * GitHub webhook installation events — installation.created / deleted /
 * suspend / unsuspend.
 */

import { repos } from "@repo/db";
import { env } from "../../config/env";
import { invalidateOrgGitHubCache, invalidateUserGitHubCache } from "./github.auth";
import type { WebhookHandlerResult } from "../webhooks/webhook.types";
import type { GitHubInstallationPayload } from "./github.types";

// ─── Installation events ─────────────────────────────────────────────────────

export async function handleInstallation(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  // SaaS-only contract: the GitHub App is owned by openship.io, so
  // installation events ONLY have authoritative meaning on the SaaS
  // (env.CLOUD_MODE=true). On a self-hosted instance the App's webhook
  // is configured to point at api.openship.io — an installation event
  // arriving here means a misconfiguration. The local DB MUST NOT
  // become a parallel source of truth for installations: cloud-app mode
  // reads installations strictly from SaaS, and a stale local row would
  // lie for up to 50min after the user uninstalls or moves the App.
  // Acknowledge with 200 (so GitHub doesn't retry forever) and refuse to
  // touch local state.
  //
  // The narrow exception is GITHUB_AUTH_MODE=app, the self-host path
  // where the operator IS running their own App with local credentials
  // and no SaaS proxy. There the webhook IS the authoritative source.
  if (!env.CLOUD_MODE && env.GITHUB_AUTH_MODE !== "app") {
    console.log(
      `[GitHub Webhook] Ignoring installation.${payload.action} on self-hosted instance — SaaS (api.openship.io) is the authoritative source for GitHub App installations.`,
    );
    return {
      success: true,
      event: "installation",
      message: "Ignored on self-hosted — SaaS is the source of truth",
    };
  }

  switch (payload.action) {
    case "created":
      return handleInstallationCreated(payload);
    case "deleted":
      return handleInstallationDeleted(payload);
    case "suspend":
      return handleInstallationSuspended(payload);
    case "unsuspend":
      return handleInstallationCreated(payload); // Re-upsert to restore
    default:
      return {
        success: true,
        event: "installation",
        message: `Installation action '${payload.action}' not handled`,
      };
  }
}

async function handleInstallationCreated(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();
  const accountType = payload.installation.account.type;

  /* Find the user by their GitHub provider ID in Better Auth's account table.
   * The connect flow runs GitHub OAuth on the SaaS BEFORE the install URL,
   * so this row should always exist by the time the install webhook fires. */
  const account = await findUserByGitHubId(senderId);
  if (!account) {
    console.log(
      `[GitHub Webhook] installation.created from GitHub user ${senderId} (${accountLogin}) — no Better Auth account row. The user installed the App without doing GitHub OAuth on the SaaS first; the connect flow should have run OAuth before returning the install URL. Returning 200 so GitHub doesn't retry; user must redo Connect from the dashboard.`,
    );
    return {
      success: true,
      event: "installation",
      message: "No linked Openship user - ignored (OAuth required first)",
    };
  }

  // not ctx-scoped: webhook background path. GitHub's installation
  // webhook payload does NOT carry the state nonce we bind in
  // resolveInstallUrl → consumeInstallState (that nonce is only
  // available on the redirect callback to the dashboard, not on the
  // webhook delivery). Without a state nonce here, we have NO authoritative
  // signal for which org the install belongs to. The fallback below
  // picks the user's first membership; their personal org
  // (deterministic id `org_<userId>`) is the second-level fallback.
  //
  // FOLLOW-UP: extend the github_install_state row to be matchable by
  // (senderId + accountLogin) so this webhook can read the org from
  // the install-state row written at request time and drop the
  // memberships[0] guess entirely. Requires either webhook ordering
  // guarantees or carrying senderId / accountLogin through the SaaS
  // install_state row.
  const memberships = await repos.member.listByUser(account.userId).catch(() => []);
  const organizationId =
    memberships[0]?.organizationId ?? `org_${account.userId}`;

  await repos.gitInstallation.upsert({
    userId: account.userId,
    organizationId,
    provider: "github",
    installationId,
    owner: accountLogin,
    ownerType: accountType,
    providerUserId: senderId,
    providerOwnerId: String(payload.installation.account.id),
    isOrg: accountType === "Organization",
  });
  await invalidateUserGitHubCache(account.userId);
  await invalidateOrgGitHubCache(organizationId);

  console.log(
    `[GitHub Webhook] installation.created on ${accountLogin} written for userId ${account.userId}`,
  );
  return {
    success: true,
    event: "installation",
    message: `Installation created for ${accountLogin}`,
  };
}

async function handleInstallationDeleted(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  const account = await findUserByGitHubId(senderId);
  if (!account) {
    await repos.gitInstallation.removeByInstallationIdForProvider(installationId);
    return { success: true, event: "installation", message: "No linked user - ignored" };
  }

  // Capture the install row's organizationId BEFORE deleting so the
  // team's shared cache entries get cleared too.
  const existing = await repos.gitInstallation
    .findByOwner(account.userId, accountLogin)
    .catch(() => null);
  await repos.gitInstallation.removeByInstallationId(account.userId, installationId);
  await invalidateUserGitHubCache(account.userId);
  if (existing?.organizationId) {
    await invalidateOrgGitHubCache(existing.organizationId);
    // Reconcile access grants: this owner's repos are gone, so prune the
    // org-level + per-repo grants pointing at it (self-healing hygiene).
    await repos.resourceGrant
      .deleteGitHubGrantsForOwner(existing.organizationId, accountLogin)
      .catch(() => 0);
  }

  return { success: true, event: "installation", message: "Installation removed" };
}

async function handleInstallationSuspended(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  const account = await findUserByGitHubId(senderId);
  if (!account) {
    await repos.gitInstallation.removeByInstallationIdForProvider(installationId);
    return { success: true, event: "installation", message: "No linked user - ignored" };
  }

  // Suspended installations can't issue tokens - remove so token resolution
  // falls back to the user's OAuth token, and linkRepo will prompt re-install.
  const existing = await repos.gitInstallation
    .findByOwner(account.userId, accountLogin)
    .catch(() => null);
  await repos.gitInstallation.removeByInstallationId(account.userId, installationId);
  await invalidateUserGitHubCache(account.userId);
  if (existing?.organizationId) {
    await invalidateOrgGitHubCache(existing.organizationId);
    // Suspended installs can't issue tokens — prune this owner's grants
    // so they don't linger; the owner re-grants on unsuspend.
    await repos.resourceGrant
      .deleteGitHubGrantsForOwner(existing.organizationId, accountLogin)
      .catch(() => 0);
  }
  console.log(`[GitHub Webhook] Installation suspended for ${accountLogin} - removed from DB`);

  return { success: true, event: "installation", message: `Installation suspended for ${accountLogin}` };
}

/**
 * Find our user by their GitHub account ID using Better Auth's account table.
 */
async function findUserByGitHubId(githubId: string) {
  const account = await repos.account.findByProviderAccountId("github", githubId);
  if (!account) return null;
  return { userId: account.userId, accountId: account.accountId };
}
