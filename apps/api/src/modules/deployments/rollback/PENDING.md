# Rollback — pending work + known limits

State as of 2026-06-12. This file lives next to the orchestrator so
anyone working on rollback sees the open questions before they pick up
new work.

---

## Shipped (the current state)

- **Three runtime primitives** (`archive`, `makeActive`, `purge`) per runtime adapter, idempotent, runtime-agnostic from the orchestrator's perspective.
- **Per-project retention** via `rollbackWindow` (default 5, max 20). Unpinned ready deployments beyond the window get purged.
- **Per-deployment pin** (`deployment.pinned`) — exempt from prune, hard-capped at 10 per project.
- **`artifact_retained_at`** is the single signal "is this deployment rollbackable?". Owned exclusively by the orchestrator.
- **`onDeploymentReady`** hook archives the previous active on every successful deploy.
- **Atomic-ish flip** in `rollback()` with a compensating runtime swap-back if the DB writes fail after the runtime succeeds.
- **Hard-link release-dir dedup** on bare via `rsync --link-dest`. node_modules etc. share inodes across releases.
- **"Redeploy this commit" fallback** in the dashboard when an artifact has been pruned. Uses the existing redeploy endpoint with `useExistingCommit: true`.
- **`project.cloudArchiveStrategy`** column exists (default `'inplace'`). Only one strategy is wired; `'offload'` is a forward-compatibility placeholder.

---

## Pending — Cloud rollback architecture

### 1. Inline workspace model (one workspace per project, not per deployment)

Currently we run **one Oblien workspace per deployment**. 5 retained deployments = 5 stopped workspaces + their archives, each billing a workspace slot.

The proposed model: **one workspace per project**, releases as folders inside:

```
/app/
  releases/
    <depId-1>/
    <depId-2>/
    <depId-3>/
  current  →  releases/<depId-3>/       # symlink
```

Workload's `working_dir` points at `/app/current`. Rollback = `ln -sfn ... current` + `workload.restart`. Instant. One slot per project. Same Capistrano shape we use on bare.

**Why this isn't shipped:** ~300-500 line refactor of `CloudRuntime.deploy` (provision-once flow), `build.service.ts` (thread `previousDeploymentId` to cloud too, currently bare-only), `project` schema (add `cloudWorkspaceId`), and a slimmed `archive/makeActive/purge` for cloud. The user is going to address the static-compute path on Oblien's side first — once that lands, we revisit.

**Migration path** (no-breaking): add `project.cloudWorkspaceId`. On deploy, if set → inline path; if not → provision the project workspace and stamp the column. Old per-deployment workspaces stay addressable for rollback until they prune out. Models coexist; projects converge naturally.

### 2. Oblien "create workspace from archive" — not supported

We verified this against the docs (`/llms.mdx/docs/api/{snapshots,workspaces,images}` + concepts). Confirmed:

- Archive endpoints are workspace-scoped (`/workspace/{wsId}/archives/*`). No account-level store.
- `workspaces.create` has NO `restore_from`, `from_archive`, `archive_id`, `seed`, `hydrate`, `from`, `source`, `template`, or `clone_from` parameter. `image` (catalog ID) is the only source identifier.
- `GET /workspace/images` is the only images endpoint — catalog is read-only; no "commit workspace to custom image" flow.
- `POST /workspace/{wsId}/restore` only restores to the LAST snapshot of THAT workspace.

Conclusion: the "kill workspace + recreate from archive" pattern the user originally wanted is **not buildable** against the current Oblien API. We'd need either:
- A new Oblien endpoint we don't have (open question with their team), or
- External durable storage (R2/S3), which we explored and reverted because it's the wrong call for Openship Cloud (should be internal to the Oblien account).

The inline workspace model (item 1) sidesteps the requirement entirely.

### 3. `cloud_archive_strategy: 'offload'` is a placeholder

The DB column accepts `'inplace' | 'offload'`. Only `'inplace'` is wired. `'offload'` is reserved for a future self-hosted-to-external-S3 path — when self-hosted users want to ship their archives off-host. Not buildable for Openship Cloud (which would need internal Oblien support per item 2).

---

## Pending — orchestrator / data model

### 4. Atomic flip is best-effort, not transactional

`rollback()` does the runtime swap then writes the DB pointer. We added a compensating runtime swap-back if the DB write fails AFTER the runtime succeeds. But the reverse — runtime succeeds, compensating swap also fails — logs a CRITICAL and leaves the system inconsistent.

The fully-correct fix is a two-phase pattern (set `pending_active_deployment_id` before, flip in a single transaction after, reconcile on startup). Not shipped — the window is genuinely narrow and the cost/value ratio doesn't justify it yet.

### 5. Per-environment rollback window

`rollbackWindow` is per-project. In practice production usually wants longer retention than preview. Either:
- Move the column to a per-environment table, or
- Resolve at runtime via `instance_settings` with an env-specific override.

Not urgent until preview deploys get heavy.

### 6. Multi-service compose rollback bookkeeping

Per-service container IDs live in `meta.composeServices[*]`. If a sibling service is added/removed between deploys, rolling back to the older deployment may bring back a stale per-service list. The orchestrator passes them through `DeploymentRef.serviceContainerIds`, but it doesn't reconcile against the project's current service list.

### 7. Health-check gate on rollback

After `start(to)`, we don't probe the new active before flipping the pointer. A rollback to a deployment that fails to come up will leave the project pointing at a broken container. Future: poll an HTTP 200 (with timeout) before commit, abort and revert on failure.

### 8. Hot-rollback for Docker (no container restart)

Today: Docker rollback `stop(from)` + `start(to)`. Each container restart costs seconds. Alternative: keep previous container running, decouple from routing, rollback = flip routing only. Sub-100ms swaps. Requires routing layer to support fast endpoint swap without container churn.

---

## Pending — UX

### 9. Health-check status chip on retained deployments

Today the dashboard shows Snapshotted / Pinned / Active chips. There's no chip for "this rollback target failed its last health probe, restoring it is risky". Tied to item 7.

### 10. Rollback diff preview

Before clicking Rollback, show what changes between active and target: env vars diff, commit range, image diff. Vercel-style preview.

### 11. Bulk delete + bulk pin

Right now pin/delete is one-at-a-time per deployment row. Bulk select for retention cleanup.

---

## Pending — bigger architectural moves (not on the near-term roadmap)

### 12. Content-addressable artifact store

Two builds producing byte-identical output pay 2× storage. A content-addressable store (build output → SHA → ref count) would dedupe across deployments and projects. Real win at scale; large new subsystem.

### 13. Bare runtime: full Capistrano (symlink-swap supervisor)

Today bare runs one supervisor unit per deployment. Full Capistrano would run one unit per project pointing at `current` symlink. Rollback = symlink swap + `systemctl reload`. Even faster than today's `stop(from)+start(to)`. Bigger refactor; current model works.

### 14. Filesystem-native snapshots on bare (zfs/btrfs)

Block-level dedup beyond rsync hard-links. Ties us to a filesystem; not portable.

---

## Decision log

- **S3/R2 offload for Openship Cloud** — rejected. Should be internal to Oblien; S3 belongs to a future self-hosted-only path.
- **`pause` instead of `stop` on archive** — rejected. Paused workspaces keep memory billed; the archive semantic must stay cheap.
- **Custom Oblien images from workspaces** — not available (read-only catalog).
- **Hard-link release dedup on bare** — shipped (via `rsync --link-dest`).
- **Redeploy-from-commit as the purged-artifact fallback** — shipped.

---

## Reference

- Orchestrator: `apps/api/src/modules/deployments/rollback/rollback-orchestrator.ts`
- Cloud primitives: `packages/adapters/src/runtime/cloud.ts:1631-1717`
- Bare primitives: `packages/adapters/src/runtime/bare.ts:528-576`
- Docker primitives: `packages/adapters/src/runtime/docker.ts:851-921`
- Schema: `packages/db/src/schema/deployment.ts` + `packages/db/src/schema/project.ts`
- Migration: `packages/db/drizzle/0021_deployment_rollback.sql` + `0022_cloud_archive_offload.sql`
- Dashboard menu: `apps/dashboard/src/app/(dashboard)/deployments/components/DeploymentMenu.tsx`
