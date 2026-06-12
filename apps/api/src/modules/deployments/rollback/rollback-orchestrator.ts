/**
 * Rollback Orchestrator — owns the archive / restore / purge policy
 * across all runtimes. The runtime adapters expose three primitives
 * (makeActive / archive / purge); this service decides WHEN to call
 * each based on the rollback policy.
 *
 * Policy:
 *
 *   1. AUTO-ARCHIVE ON DEPLOY — when a new deployment goes ready, the
 *      previously-active deployment is archived (artifact preserved,
 *      compute stopped). Means every successful deploy automatically
 *      saves the previous version for rollback.
 *
 *   2. AUTO-PURGE ON RETENTION OVERFLOW — after archiving, prune runs.
 *      Drops the oldest unpinned ready deployments beyond
 *      project.rollbackWindow (default 5, max 20). Pinned deployments
 *      are exempt.
 *
 * A deployment is "rollbackable" iff its artifact is archived — which
 * the database tracks as `artifact_retained_at IS NOT NULL`. This
 * column is owned EXCLUSIVELY by this service.
 *
 * The orchestrator is policy-only — it never touches the runtime
 * directly except through the three primitives. Lifecycle, retention,
 * and the rollback API endpoint all delegate here.
 */

import { repos, type Deployment } from "@repo/db";
import type { DeploymentRef } from "@repo/adapters";
import { AppError } from "@repo/core";
import { resolveDeploymentRuntime } from "../../../lib/deployment-runtime";
import { resolveRollbackWindow } from "../release-retention";

// ─── Error codes (surfaced to the API layer) ────────────────────────────────

export const ROLLBACK_ERROR_CODES = {
  NOT_READY: "ROLLBACK_NOT_READY",
  ALREADY_ACTIVE: "ROLLBACK_ALREADY_ACTIVE",
  ARTIFACT_GONE: "ROLLBACK_ARTIFACT_GONE",
  UNSUPPORTED_RUNTIME: "ROLLBACK_UNSUPPORTED_RUNTIME",
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Project the DB Deployment row down to the minimal DeploymentRef the
 *  runtime primitives consume. Keeps the adapter layer free of
 *  DB-specific shapes. */
function toRef(dep: Deployment): DeploymentRef {
  // Multi-service compose deploys stash per-service container IDs in meta.
  const meta = (dep.meta ?? {}) as Record<string, unknown>;
  const composeServices = meta.composeServices as
    | Array<{ name: string; containerId?: string }>
    | undefined;
  const serviceContainerIds = composeServices?.reduce<Record<string, string>>(
    (acc, svc) => {
      if (svc.containerId) acc[svc.name] = svc.containerId;
      return acc;
    },
    {},
  );
  return {
    id: dep.id,
    projectId: dep.projectId,
    imageRef: dep.imageRef,
    containerId: dep.containerId,
    serviceContainerIds,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Called by the deployment lifecycle when a new deployment goes
 * `ready`. Archives the previously-active deployment, marks the new
 * one as the active+retained, runs retention prune.
 *
 * Idempotent — safe to call twice with the same arguments. Errors in
 * archive/prune are logged but don't fail the new deployment (it's
 * already live; we don't want bookkeeping issues to roll it back).
 */
export async function onDeploymentReady(opts: {
  newDeployment: Deployment;
  previousActive: Deployment | null;
}): Promise<void> {
  const { newDeployment, previousActive } = opts;

  // 1. Archive the previous active (if any and different from the new one).
  if (previousActive && previousActive.id !== newDeployment.id) {
    try {
      const { runtime } = await resolveDeploymentRuntime(previousActive);
      if (runtime.supports("rollback")) {
        await runtime.archive(toRef(previousActive));
      }
      await repos.deployment.setArtifactRetainedAt(previousActive.id, new Date());
    } catch (err) {
      console.error(
        `[rollback-orchestrator] Failed to archive previous deployment ${previousActive.id}:`,
        err,
      );
    }
  }

  // 2. Mark the new deployment as retained (its artifact is the
  //    currently-active one — fully rollback-restorable).
  await repos.deployment.setArtifactRetainedAt(newDeployment.id, new Date());

  // 3. Prune older deployments beyond the rollback window. Pinned
  //    deployments are exempt.
  try {
    await prune(newDeployment.projectId);
  } catch (err) {
    console.error(
      `[rollback-orchestrator] Prune failed for project ${newDeployment.projectId}:`,
      err,
    );
  }
}

/**
 * User-triggered rollback to a specific deployment.
 *
 * Validates the target is rollback-eligible, archives the currently-
 * active deployment, then makes the target active via the runtime
 * primitive.
 */
export async function rollback(targetDeploymentId: string): Promise<void> {
  const target = await repos.deployment.findById(targetDeploymentId);
  if (!target) {
    throw new AppError("Deployment not found", 404, "DEPLOYMENT_NOT_FOUND");
  }
  if (target.status !== "ready") {
    throw new AppError(
      "Only successful deployments can be rolled back to.",
      409,
      ROLLBACK_ERROR_CODES.NOT_READY,
    );
  }

  const project = await repos.project.findById(target.projectId);
  if (!project) {
    throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
  }
  if (project.activeDeploymentId === target.id) {
    throw new AppError(
      "This deployment is already active.",
      409,
      ROLLBACK_ERROR_CODES.ALREADY_ACTIVE,
    );
  }
  if (!target.artifactRetainedAt) {
    throw new AppError(
      "Rollback artifact is no longer retained for this deployment.",
      409,
      ROLLBACK_ERROR_CODES.ARTIFACT_GONE,
    );
  }

  const { runtime } = await resolveDeploymentRuntime(target);
  if (!runtime.supports("rollback")) {
    throw new AppError(
      `Runtime "${runtime.name}" does not support rollback.`,
      409,
      ROLLBACK_ERROR_CODES.UNSUPPORTED_RUNTIME,
    );
  }

  const currentActive = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : null;

  // The runtime primitive handles BOTH halves of the swap: it stops
  // `from` (which is the runtime-level "archive" — container stopped,
  // workspace stopped, etc.) AND starts `to`. We don't call
  // runtime.archive() separately afterwards — that would just call
  // stop again on an already-stopped container.
  const result = await runtime.makeActive({
    from: currentActive ? toRef(currentActive) : null,
    to: toRef(target),
  });

  // ── Atomic-ish DB writes with compensating runtime rollback ────────
  //
  // The runtime has already swapped. We must now either commit BOTH DB
  // updates (container_id, active pointer) or revert the runtime swap
  // back to where it was. The narrow window between the two DB writes
  // is what we're closing here — without compensation, a crash between
  // them would leave the dashboard pointing at the wrong row.
  //
  // We try the DB writes; on any failure, we ask the runtime to swap
  // BACK and let the user retry. If even the compensating swap fails,
  // we log a CRITICAL marker for manual reconciliation (rare; usually
  // the runtime API just isn't reachable).
  try {
    if (result.containerId && result.containerId !== target.containerId) {
      await repos.deployment.setContainerId(
        target.id,
        result.containerId,
        result.url ?? undefined,
      );
    }
    // currentActive's `artifact_retained_at` was already set when IT
    // became active (its own onDeploymentReady call). It stays set —
    // currentActive is now the rollback-restorable previous version.
    await repos.project.setActiveDeployment(target.projectId, target.id);
  } catch (dbErr) {
    console.error(
      `[rollback] DB write failed after runtime swap of ${target.id}; attempting compensating runtime rollback:`,
      dbErr,
    );
    try {
      if (currentActive) {
        await runtime.makeActive({
          // The target may have been re-tagged with a new container id by
          // the just-succeeded swap (Docker cold-restart from image). Use
          // whatever id is now live.
          from: { ...toRef(target), containerId: result.containerId ?? target.containerId },
          to: toRef(currentActive),
        });
      } else {
        // No prior active means we just promoted into an empty slot.
        // Best we can do is stop the just-promoted runtime.
        await runtime.archive(toRef(target));
      }
    } catch (compErr) {
      console.error(
        `[rollback] CRITICAL: compensating swap also failed for ${target.id}. Runtime and DB are now inconsistent — runtime serves ${result.containerId ?? target.containerId}, DB still records ${project.activeDeploymentId}. Manual reconciliation required.`,
        compErr,
      );
    }
    throw dbErr;
  }
}

/**
 * Enforce retention policy: ready deployments older than
 * `project.rollbackWindow` get their artifacts purged, UNLESS they're
 * pinned. The active deployment is never purged.
 *
 * Called by `onDeploymentReady` after every successful deploy. Also
 * exposed as an explicit op for admin tooling.
 */
export async function prune(projectId: string): Promise<{ purged: number }> {
  const project = await repos.project.findById(projectId);
  if (!project) return { purged: 0 };

  const rollbackWindow = await resolveRollbackWindow(project);
  // Newest first. Within the window we keep; beyond it we purge unless pinned.
  const ready = await repos.deployment.listReadyOrderedDesc(projectId);

  let unpinnedRetained = 0;
  let purged = 0;

  for (const dep of ready) {
    if (dep.id === project.activeDeploymentId) {
      // Never purge the active one regardless of position.
      continue;
    }
    if (dep.pinned) {
      // Pinned deployments are exempt — always keep their artifact.
      // They also DON'T count toward the rollbackWindow budget.
      continue;
    }
    if (unpinnedRetained < rollbackWindow) {
      unpinnedRetained += 1;
      continue;
    }
    // Overflow: purge.
    if (dep.artifactRetainedAt) {
      try {
        const { runtime } = await resolveDeploymentRuntime(dep);
        if (runtime.supports("rollback")) {
          await runtime.purge(toRef(dep));
        }
        await repos.deployment.setArtifactRetainedAt(dep.id, null);
        purged += 1;
      } catch (err) {
        console.error(
          `[rollback-orchestrator] Failed to purge ${dep.id}:`,
          err,
        );
      }
    }
  }

  return { purged };
}

// ─── Pin / unpin ────────────────────────────────────────────────────────────

/**
 * Cap on pinned deployments per project. Bounds disk usage. Today
 * hardcoded; could be moved to instance_settings later.
 */
const MAX_PINNED_PER_PROJECT = 10;

export const PIN_ERROR_CODES = {
  LIMIT_REACHED: "PIN_LIMIT_REACHED",
  NOT_READY: "PIN_NOT_READY",
  ARTIFACT_GONE: "PIN_ARTIFACT_GONE",
} as const;

export async function setPin(
  deploymentId: string,
  pinned: boolean,
): Promise<void> {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) {
    throw new AppError("Deployment not found", 404, "DEPLOYMENT_NOT_FOUND");
  }

  if (pinned) {
    if (dep.status !== "ready") {
      throw new AppError(
        "Only successful deployments can be pinned.",
        409,
        PIN_ERROR_CODES.NOT_READY,
      );
    }
    if (!dep.artifactRetainedAt) {
      throw new AppError(
        "Cannot pin: rollback artifact is no longer retained for this deployment.",
        409,
        PIN_ERROR_CODES.ARTIFACT_GONE,
      );
    }
    const current = await repos.deployment.countPinned(dep.projectId);
    if (current >= MAX_PINNED_PER_PROJECT) {
      throw new AppError(
        `Pin limit reached (${MAX_PINNED_PER_PROJECT}). Unpin an older deployment first.`,
        409,
        PIN_ERROR_CODES.LIMIT_REACHED,
      );
    }
  }

  await repos.deployment.setPinned(deploymentId, pinned);
}
