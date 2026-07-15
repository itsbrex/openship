/**
 * Folder-upload deploy sessions.
 *
 * Lets a browser (SaaS or self-hosted) create a project from a local folder by
 * uploading its contents to a pre-created build workspace, then running the
 * normal build/deploy pipeline. Two byte-transports, one control-plane:
 *
 *   - SaaS (CLOUD_MODE): provision an Oblien *temporary* workspace + mint a
 *     workspace-scoped token; the browser uploads the tar.gz DIRECTLY to the
 *     workspace (mode "oblien-direct"). Deploy adopts that workspace.
 *   - Self-hosted: create a staging dir on this host + a single-use relay
 *     ticket; the browser uploads to POST /projects/folder/upload/:id (mode
 *     "api-relay"), and the existing localPath→transfer pipeline ships it on.
 *
 * Sessions are RAM-only with a TTL (like terminal sessions): the workspace /
 * staging dir they point at is itself short-lived, so surviving a restart is
 * meaningless.
 */

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { getBuildImage, safeErrorMessage, type StackId } from "@repo/core";
import { env } from "../../../config/env";
import { getNamespaceClient } from "../../../lib/openship-cloud";
import {
  newFolderSessionId,
  putFolderSession,
  sweepExpiredFolderSessions,
  type FolderSession,
} from "./session-store";

const execFileAsync = promisify(execFile);

/** How long a session (and the workspace/staging dir it points at) is valid —
 *  generous so upload → wizard → deploy comfortably fits. */
const SESSION_TTL_MS = 60 * 60_000;
/** Oblien scoped-token / workspace TTL. Token max is 3600s; workspace is made
 *  permanent on deploy, removed on TTL otherwise. */
const WORKSPACE_TTL = "60m";
const TOKEN_TTL_S = 3600;

/** Build-time resources for the upload workspace. Deploy makes it permanent
 *  (and can resize); these just need to be enough to install + build. */
const UPLOAD_BUILD_RESOURCES = { cpus: 2, memory_mb: 2048, disk_size_mb: 8192 } as const;

/** Oblien runtime gateway (routes by the workspace-scoped token). Server-side
 *  only — the browser never learns this; it just gets an opaque upload URL. */
const OBLIEN_RUNTIME_URL = "https://workspace.oblien.com";

/** Evict expired sessions (via the store) and clean up any staging dirs they
 *  owned. The store stays free of node:fs, so the fs cleanup lives here. */
function sweepExpired(now: number): void {
  for (const s of sweepExpiredFolderSessions(now)) {
    if (s.stagingDir) void rm(s.stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface CreateFolderSessionInput {
  orgId: string;
  userId: string;
  /** Client-detected stack — picks the workspace image for the cloud path. */
  stack?: string;
  packageManager?: string;
  name?: string;
}

/**
 * Opaque upload target handed to the browser. The client is deliberately DUMB
 * about where this points (Oblien workspace, this API, a future object store):
 * it just POSTs the tar.gz to `url` with `headers`. Keeping the destination
 * server-owned means we can change it later without touching the client.
 */
export interface UploadTarget {
  /** Absolute URL (external), or an API-relative path the client resolves
   *  against its API base. */
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** Send the browser's session cookie? true for the same-origin API relay,
   *  false for an external target (so cookies never leak cross-origin). */
  withCredentials: boolean;
}

export interface FolderSessionResult {
  sessionId: string;
  expiresAt: number;
  upload: UploadTarget;
}

/**
 * Open an upload session. On the SaaS this provisions the Oblien workspace and
 * mints a browser-safe workspace-scoped token; self-hosted just prepares a
 * staging dir + relay ticket.
 */
export async function createFolderSession(
  input: CreateFolderSessionInput,
): Promise<FolderSessionResult> {
  const now = Date.now();
  sweepExpired(now);

  const id = newFolderSessionId();
  const expiresAt = now + SESSION_TTL_MS;

  if (env.CLOUD_MODE) {
    // ── SaaS: direct browser → Oblien workspace ──
    // Use the org's NAMESPACE-scoped client (same as every other cloud service:
    // cloud-pages, cloud-edge-proxy, deploy). The master client can create a
    // namespaced workspace but then can't resolve it by bare id — runtime()/
    // tokens.create fail "workspace does not exist". The namespace token gates
    // by-id ops to this org's namespace, so create + runtime + mint all agree.
    const { client, namespace } = await getNamespaceClient(input.orgId);
    // The workspace image is fixed at create time, so resolve it from the
    // client-detected stack when known; fall back to a general JS/TS base
    // otherwise (most uploads are Node/Bun; a mismatch just means the user
    // re-uploads after switching the build image).
    let image: string;
    try {
      if (!input.stack) throw new Error("no stack hint");
      image = getBuildImage(input.stack as StackId, input.packageManager);
    } catch {
      image = input.packageManager === "bun" ? "oven/bun:latest" : "node:22";
    }

    let workspaceId: string;
    try {
      const ws = await client.workspaces.create({
        name: `upload-${input.orgId.slice(0, 16)}-${id.slice(0, 6)}`,
        namespace,
        image,
        mode: "temporary",
        config: {
          cpus: UPLOAD_BUILD_RESOURCES.cpus,
          memory_mb: UPLOAD_BUILD_RESOURCES.memory_mb,
          disk_size_mb: UPLOAD_BUILD_RESOURCES.disk_size_mb,
        },
      });
      workspaceId = ws.id;
    } catch (err) {
      throw new Error(`Failed to provision upload workspace: ${safeErrorMessage(err)}`);
    }

    // Temporary from creation with auto-cleanup: if the upload or deploy never
    // completes, Oblien reaps the workspace — no orphan, nothing to hand-delete.
    // A successful deploy promotes it to permanent (build/access →
    // adoptWorkspaceRuntime → makePermanent), exactly like a build workspace.
    // `remove_on_exit` mirrors provisionBuildWorkspace; create-time ttl is
    // unreliable so it's set here (best-effort — the row is already temporary).
    const ws = client.workspace(workspaceId);
    await ws.lifecycle
      .makeTemporary({ ttl: WORKSPACE_TTL, ttl_action: "remove", remove_on_exit: true })
      .catch(() => {});

    let uploadToken: string;
    try {
      // Acquire the runtime handle before minting the upload token. This is the
      // SAME step the deploy path uses (provisionBuildWorkspace /
      // adoptWorkspaceRuntime): it waits out the post-create eventual-consistency
      // AND enables the workspace's runtime API server — which is what the
      // browser then POSTs the tar.gz to. Minting/uploading before this raced the
      // create ("workspace does not exist"). One short backoff, same as deploy.
      for (let attempt = 0; ; attempt++) {
        try {
          await ws.runtime();
          break;
        } catch (err) {
          if (attempt >= 2) throw err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      const tok = await client.tokens.create({
        scope: "workspace",
        workspaceId,
        ttl: TOKEN_TTL_S,
        label: `folder-upload ${id.slice(0, 6)}`,
      });
      uploadToken = tok.token;
    } catch (err) {
      // remove_on_exit reaps it regardless; delete eagerly so we don't wait.
      await ws.delete().catch(() => {});
      throw new Error(`Failed to provision upload workspace: ${safeErrorMessage(err)}`);
    }

    putFolderSession({
      id,
      orgId: input.orgId,
      userId: input.userId,
      mode: "oblien-direct",
      createdAt: now,
      expiresAt,
      workspaceId,
      uploaded: false,
      name: input.name,
    });

    return {
      sessionId: id,
      expiresAt,
      upload: {
        url: `${OBLIEN_RUNTIME_URL}/files/transfer/upload?dest=/app`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/gzip",
        },
        withCredentials: false,
      },
    };
  }

  // ── Self-hosted: relay upload to a staging dir on this host ──
  const stagingDir = await mkdtemp(join(tmpdir(), "openship-upload-"));
  const uploadTicket = randomBytes(24).toString("base64url");

  putFolderSession({
    id,
    orgId: input.orgId,
    userId: input.userId,
    mode: "api-relay",
    createdAt: now,
    expiresAt,
    stagingDir,
    uploadTicket,
    uploaded: false,
    name: input.name,
  });

  return {
    sessionId: id,
    expiresAt,
    upload: {
      url: `projects/folder/upload/${id}`,
      method: "POST",
      headers: {
        "x-upload-ticket": uploadTicket,
        "Content-Type": "application/gzip",
      },
      withCredentials: true,
    },
  };
}

/**
 * Accept an uploaded tar.gz for a self-hosted (api-relay) session: stream it to
 * disk and extract into the staging dir. Ticket-checked by the caller.
 */
export async function acceptRelayUpload(
  session: FolderSession,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  if (session.mode !== "api-relay" || !session.stagingDir) {
    throw new Error("Session does not accept relay uploads");
  }

  const archivePath = join(session.stagingDir, "__upload.tar.gz");
  await streamToFile(body, archivePath);

  try {
    await safeExtractTarGz(archivePath, session.stagingDir);
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
  }

  session.uploaded = true;
}

/**
 * Extract a tar.gz into `destDir`, defended against path traversal (Zip-Slip).
 * The tarball is client-supplied — an authenticated org member could bypass the
 * browser packer and POST a crafted archive — so we do NOT trust it: list every
 * member first and REJECT any absolute path or `..` component before extracting.
 * This check is independent of the tar implementation's own (varying) safety
 * behavior. Extraction then runs without restoring archive ownership.
 */
async function safeExtractTarGz(archivePath: string, destDir: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tzf", archivePath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const raw of stdout.split("\n")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("/") || entry.startsWith("~")) {
      throw new Error("Rejected upload: archive contains an absolute path");
    }
    if (entry.split("/").some((seg) => seg === "..")) {
      throw new Error("Rejected upload: archive contains a path-traversal entry");
    }
  }

  await execFileAsync(
    "tar",
    ["-xzf", archivePath, "-C", destDir, "--no-same-owner"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

async function streamToFile(body: ReadableStream<Uint8Array>, dest: string): Promise<void> {
  // `pipeline` handles backpressure, propagates errors from BOTH ends, and
  // destroys the streams on failure — so a disk-full/permission error rejects
  // here instead of surfacing as an unhandled 'error' that crashes the process.
  await pipeline(Readable.fromWeb(body as NodeWebReadableStream<Uint8Array>), createWriteStream(dest));
}

/**
 * Authoritative framework detection on the uploaded source.
 *   - oblien-direct: read the workspace filesystem via the runtime.
 *   - api-relay: read the staging dir via node:fs (self-hosted only).
 */
export async function scanFolderSession(session: FolderSession) {
  if (session.mode === "oblien-direct") {
    if (!session.workspaceId) throw new Error("Session has no workspace");
    // Namespace-scoped client (not the master) so the by-id runtime lookup
    // resolves within the org's namespace — same reason as createFolderSession.
    const { client } = await getNamespaceClient(session.orgId);
    const rt = await client.workspaces.runtime(session.workspaceId);
    const { resolveFromRuntime } = await import("../../deployments/runtime-source");
    return resolveFromRuntime(rt, session.name ?? "app");
  }

  if (!session.stagingDir) throw new Error("Session has no staging directory");
  const st = await stat(session.stagingDir).catch(() => null);
  if (!st?.isDirectory()) throw new Error("Uploaded source not found");
  const { resolveFromLocal } = await import("../../deployments/local-source");
  return resolveFromLocal(session.stagingDir);
}
