export interface Deployment {
  id: string;
  status: "success" | "failed" | "building" | "pending" | "canceled" | "cancelled";
  domain: string;
  framework: string;
  commit: {
    hash: string;
    fullHash?: string | null;
    message: string;
    author: string;
    timestamp: string;
    url?: string | null;
    changedFiles?: Array<{
      name: string;
      type: 'added' | 'modified' | 'removed';
      language?: string;
    }>;
  };
  buildTime: number | null;
  createdAt: string;
  type: string;
  environment: string;
  owner?: string;
  repo?: string;
  branch?: string;
  projectId?: string;
  projectName?: string;
  failureReason?: string;
  /** Rollback state — populated by the orchestrator-aware listing endpoint.
   *  `artifactRetainedAt` non-null = artifact is archived, rollback-eligible.
   *  `pinned` true = user-tagged to survive retention prune.
   *  `isActive` true = this is the project's active deployment right now. */
  artifactRetainedAt?: string | null;
  pinned?: boolean;
  isActive?: boolean;
}

export interface Project {
  id: string;
  name: string;
}

export interface DeploymentStats {
  total: number;
  success: number;
  failed: number;
  building: number;
  pending?: number;
  canceled?: number;
}

