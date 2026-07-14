/**
 * `openship status` — snapshot of the active context's API.
 *
 * Hits two unauthenticated endpoints on the health module
 * (health.routes.ts, mounted at /api/health):
 *   GET /api/health      → { status, timestamp }
 *   GET /api/health/env  → { selfHosted, deployMode, authMode, teamMode,
 *                            cloudAuthUrl, cloudApiUrl, ... }
 */
import { Command } from "commander";
import chalk from "chalk";
import { apiRequest, getApiUrl, ApiError } from "../lib/api-client";
import { getActiveContext } from "../lib/config";
import { err, isJsonMode, printJson } from "../lib/output";

interface Health {
  status?: string;
  timestamp?: string;
}
interface HealthEnv {
  selfHosted?: boolean;
  deployMode?: string;
  authMode?: string;
  teamMode?: string;
  cloudAuthUrl?: string | null;
  cloudApiUrl?: string | null;
  machineName?: string;
  hostDomain?: string;
}

export const statusCommand = new Command("status")
  .description("Show the active context's API health and deployment info")
  .action(async () => {
    const context = getActiveContext();
    const apiUrl = getApiUrl();

    let health: Health;
    let envInfo: HealthEnv;
    try {
      health = await apiRequest<Health>("/health", { signal: AbortSignal.timeout(8000) });
      envInfo = await apiRequest<HealthEnv>("/health/env", { signal: AbortSignal.timeout(8000) });
    } catch (e) {
      if (isJsonMode()) {
        printJson({ context, apiUrl, reachable: false });
      } else {
        const msg = e instanceof ApiError ? e.message : (e as Error).message;
        err(`\n  Cannot reach the API at ${apiUrl}: ${msg}\n`);
      }
      process.exit(1);
    }

    if (isJsonMode()) {
      printJson({ context, apiUrl, reachable: true, health, env: envInfo });
      return;
    }

    const row = (label: string, value: unknown) =>
      `  ${chalk.dim(label.padEnd(14))}${value ?? chalk.dim("-")}\n`;

    process.stdout.write(
      chalk.bold("\n  Openship status\n\n") +
        row("Context", context) +
        row("API", apiUrl) +
        row("Health", chalk.green(health.status ?? "ok")) +
        row("Mode", envInfo.selfHosted ? "self-hosted" : "cloud") +
        row("Deploy", envInfo.deployMode) +
        row("Auth", envInfo.authMode) +
        row("Team", envInfo.teamMode) +
        (envInfo.hostDomain ? row("Host domain", envInfo.hostDomain) : "") +
        (envInfo.machineName ? row("Machine", envInfo.machineName) : "") +
        "\n",
    );
  });
