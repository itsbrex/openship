/**
 * `openship logs <deploymentId>` — deployment logs.
 *
 *   default:   GET /api/deployments/:id/logs  → { data: LogEntry[] } (snapshot)
 *   --follow:  GET /api/deployments/:id/stream → SSE build-session stream
 *
 * (deployment.controller.ts:logs / stream)
 */
import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client";
import { streamDeploymentLogs } from "../lib/deploy-stream";
import { isJsonMode, printJson, err } from "../lib/output";

interface LogEntry {
  message?: string;
  level?: string;
  timestamp?: string;
}

export const logsCommand = new Command("logs")
  .description("View or stream a deployment's logs")
  .argument("<deploymentId>", "Deployment ID")
  .option("-f, --follow", "Stream live logs via SSE until the deployment finishes")
  .option("--tail <n>", "Show only the last N log lines (snapshot mode)")
  .action(async (deploymentId: string, opts) => {
    if (opts.follow) {
      try {
        const result = await streamDeploymentLogs(deploymentId);
        if (result.success === false || result.status === "cancelled") process.exit(1);
      } catch (e) {
        err(e instanceof ApiError ? e.message : String(e));
        process.exit(1);
      }
      return;
    }

    const query = opts.tail ? `?tail=${encodeURIComponent(opts.tail)}` : "";
    try {
      const res = await apiRequest<{ data?: LogEntry[] }>(
        `/deployments/${deploymentId}/logs${query}`,
      );
      const entries = res.data ?? [];
      if (isJsonMode()) {
        printJson(entries);
        return;
      }
      for (const e of entries) {
        const msg = e.message ?? "";
        process.stdout.write(msg.endsWith("\n") ? msg : msg + "\n");
      }
    } catch (e) {
      err(e instanceof ApiError ? e.message : String(e));
      process.exit(1);
    }
  });
