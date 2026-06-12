"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  MoreVertical,
  ExternalLink,
  Copy,
  RotateCcw,
  RefreshCw,
  XCircle,
  Trash2,
  Pin,
  PinOff,
} from "lucide-react";
import { generateIcon } from "@/utils/icons";
import { deployApi, getApiErrorMessage } from "@/lib/api";

interface Deployment {
  id: string;
  status: string;
  domain: string;
  owner?: string;
  repo?: string;
  commit: {
    hash: string;
    /** Full SHA when known — required by "Redeploy this commit". */
    fullHash?: string | null;
  };
  /** Rollback state — flows from the orchestrator-aware listing endpoint. */
  artifactRetainedAt?: string | null;
  pinned?: boolean;
  isActive?: boolean;
}

interface DeploymentMenuProps {
  deployment: Deployment;
  triggerClassName?: string;
  onStatusChange?: () => void;
}

export const DeploymentMenu: React.FC<DeploymentMenuProps> = ({
  deployment,
  triggerClassName,
  onStatusChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // `isInFlight` = status-wise busy (the cancel/delete affordances care
  // about this). Distinct from `deployment.isActive` which means
  // "currently the active version" — the chip / rollback gating cares
  // about that one.
  const isInFlight = ["pending", "queued", "building", "deploying"].includes(deployment.status);
  const canRollback =
    deployment.status === "ready" &&
    !deployment.isActive &&
    !!deployment.artifactRetainedAt;
  // Surfaced when rollback is unavailable because the artifact was pruned —
  // the user can still rebuild this exact commit from source. Requires a
  // commit SHA to be on file (manual deploys without one are excluded).
  const canRedeployCommit =
    !canRollback &&
    !deployment.isActive &&
    !isInFlight &&
    !!deployment.commit?.fullHash &&
    deployment.commit.fullHash !== "N/A";

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    try {
      await deployApi.cancel(deployment.id);
      onStatusChange?.();
    } catch {
      /* silent */
    }
  };

  const handleRollback = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    if (!canRollback) return;
    const ok = window.confirm(
      "Roll back to this version?\n\n" +
        "This restores the application code only. Database and volume data are unchanged.",
    );
    if (!ok) return;
    try {
      await deployApi.rollback(deployment.id);
      onStatusChange?.();
    } catch (err) {
      window.alert(getApiErrorMessage(err, "Rollback failed"));
    }
  };

  const handleRedeployCommit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    if (!canRedeployCommit) return;
    const shortHash = deployment.commit.hash;
    const ok = window.confirm(
      `Redeploy commit ${shortHash}?\n\n` +
        "Rebuilds this exact commit from source. Slower than rollback " +
        "(full build runs again), but works even after the rollback artifact " +
        "has been pruned. A new deployment will appear in the list.",
    );
    if (!ok) return;
    try {
      await deployApi.redeploy(deployment.id, { useExistingCommit: true });
      onStatusChange?.();
    } catch (err) {
      window.alert(getApiErrorMessage(err, "Redeploy failed"));
    }
  };

  const handleTogglePin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    try {
      await deployApi.pin(deployment.id, !deployment.pinned);
      onStatusChange?.();
    } catch (err) {
      window.alert(
        getApiErrorMessage(
          err,
          deployment.pinned ? "Failed to unpin deployment" : "Failed to pin deployment",
        ),
      );
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    try {
      await deployApi.deleteDeployment(deployment.id);
      onStatusChange?.();
    } catch {
      /* silent */
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className={triggerClassName || "w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"}
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-10 w-56 bg-popover rounded-xl shadow-lg border border-border/50 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
          {deployment.domain && (
            <button
              onClick={() => {
                window.open(`https://${deployment.domain}`, "_blank");
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              <ExternalLink className="w-4 h-4" />
              Open Deployment
            </button>
          )}

          {deployment.owner && deployment.repo && (
            <button
              onClick={() => {
                window.open(`https://github.com/${deployment.owner}/${deployment.repo}`, "_blank");
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              {generateIcon('https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg', 16, 'currentColor', {}, true)}
              View Repository
            </button>
          )}

          <div className="h-px bg-border/50 my-2" />

          {deployment.domain && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(`https://${deployment.domain}`);
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              <Copy className="w-4 h-4" />
              Copy Domain URL
            </button>
          )}

          <button
            onClick={() => {
              navigator.clipboard.writeText(deployment.id);
              setIsOpen(false);
            }}
            className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
          >
            <Copy className="w-4 h-4" />
            Copy Build ID
          </button>

          {isInFlight && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={handleCancel}
                className="w-full px-4 py-2.5 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-3"
              >
                <XCircle className="w-4 h-4" />
                Cancel Deployment
              </button>
            </>
          )}

          {/* Rollback path — instant restore from the preserved artifact.
              Enabled iff status=ready, not currently active, AND artifact
              is still retained (not pruned). */}
          {!isInFlight && deployment.status !== "building" && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={handleRollback}
                disabled={!canRollback}
                title={
                  canRollback
                    ? "Restore the project to this version (code only — data is unchanged)"
                    : deployment.isActive
                      ? "This is already the active version"
                      : !deployment.artifactRetainedAt
                        ? "Rollback artifact has been pruned. Use 'Redeploy this commit' to rebuild from source instead."
                        : "Only ready deployments can be rolled back to"
                }
                className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <RotateCcw className="w-4 h-4" />
                Rollback to this version
              </button>

              {/* Fallback for when the artifact has been pruned out of the
                  rollback window: rebuild the same commit from source. Only
                  shown when rollback isn't available, so the two CTAs never
                  overlap. */}
              {canRedeployCommit && (
                <button
                  onClick={handleRedeployCommit}
                  title="Rebuild this exact commit from source. Slower than rollback but works after the artifact has been pruned."
                  className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
                >
                  <RefreshCw className="w-4 h-4" />
                  Redeploy this commit
                </button>
              )}
            </>
          )}

          {/* Pin / Unpin — toggles the artifact's exemption from
              retention prune. Available for any ready deployment. */}
          {!isInFlight && deployment.status === "ready" && (
            <button
              onClick={handleTogglePin}
              disabled={!deployment.pinned && !deployment.artifactRetainedAt}
              title={
                deployment.pinned
                  ? "Allow this deployment to be pruned when retention overflows"
                  : !deployment.artifactRetainedAt
                    ? "Cannot pin — artifact has already been pruned"
                    : "Keep this deployment rollback-restorable indefinitely (cap: 10 pinned per project)"
              }
              className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              {deployment.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
              {deployment.pinned ? "Unpin" : "Pin"}
            </button>
          )}

          {!isInFlight && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={handleDelete}
                className="w-full px-4 py-2.5 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-3"
              >
                <Trash2 className="w-4 h-4" />
                Delete Deployment
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

