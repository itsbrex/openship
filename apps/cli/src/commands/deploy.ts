/**
 * `openship deploy` — trigger a deployment for a git-linked project.
 *
 * POST /api/deployments (deployment.controller.ts:create). The controller
 * accepts an explicit allowlist from the body:
 *   { projectId, branch, commitSha, environment, forceAll, serviceIds,
 *     smartRoute, refresh }
 * and responds 202 with { data: { deployment_id, project_id } }. The build is
 * kicked off before the response returns, so --watch attaches to the safe
 * GET /:id/stream SSE path.
 */
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import ora from "ora";
import { apiRequest, ApiError } from "../lib/api-client";
import { readProjectLink } from "../lib/project-link";
import { streamDeploymentLogs } from "../lib/deploy-stream";
import { isJsonMode, printJson, ok, err, info } from "../lib/output";

/** Read a value from git, or undefined when not in a repo / git missing. */
function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || undefined;
  } catch {
    return undefined;
  }
}

interface CreateResponse {
  data?: { success?: boolean; deployment_id?: string; project_id?: string };
}

export const deployCommand = new Command("deploy")
  .description("Trigger a deployment for the current project")
  .option("--project <id>", "Project ID (defaults to the linked project in .openship/project.json)")
  .option("--branch <name>", "Git branch to deploy (defaults to the current branch)")
  .option("--commit <sha>", "Specific commit SHA (defaults to the latest commit on the branch)")
  .option("--env <environment>", "Target environment: production | preview", "production")
  .option("--force-all", "Rebuild every enabled service (skip smart per-service routing)")
  .option("--service-ids <ids>", "Comma-separated service IDs to deploy (smart routing)")
  .option("--smart-route", "Rebuild only services changed since the active deploy")
  .option("--refresh", "Re-apply current env to the active deploy (no git pull, no rebuild)")
  .option("--watch", "Stream the deployment logs until it finishes")
  .action(async (opts) => {
    const link = readProjectLink();
    const projectId: string | undefined = opts.project || link?.projectId;
    if (!projectId) {
      err("No project specified. Pass --project <id> or run `openship init` to link one.");
      process.exit(1);
    }

    const env: string = opts.env;
    if (env !== "production" && env !== "preview") {
      err(`Invalid --env "${env}". Must be "production" or "preview".`);
      process.exit(1);
    }

    const branch: string | undefined =
      opts.branch || link?.branch || git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const serviceIds: string[] | undefined = opts.serviceIds
      ? opts.serviceIds.split(",").map((s: string) => s.trim()).filter(Boolean)
      : undefined;

    const body = {
      projectId,
      branch,
      commitSha: opts.commit || undefined,
      environment: env,
      forceAll: opts.forceAll || undefined,
      serviceIds,
      smartRoute: opts.smartRoute || undefined,
      refresh: opts.refresh || undefined,
    };

    const spinner = isJsonMode() ? null : ora("Triggering deployment").start();
    let res: CreateResponse;
    try {
      res = await apiRequest<CreateResponse>("/deployments", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (e) {
      spinner?.fail("Deployment failed to start");
      err(e instanceof ApiError ? e.message : String(e));
      process.exit(1);
    }

    const deploymentId = res.data?.deployment_id;
    spinner?.succeed(deploymentId ? `Deployment queued: ${deploymentId}` : "Deployment queued");

    if (isJsonMode() && !opts.watch) {
      printJson(res.data ?? res);
      return;
    }

    if (!deploymentId) {
      info("No deployment id returned; nothing to watch.");
      return;
    }

    if (!opts.watch) {
      info(`Follow with: openship logs ${deploymentId} --follow`);
      return;
    }

    const result = await streamDeploymentLogs(deploymentId);
    if (result.success === false || result.status === "cancelled") process.exit(1);
  });
