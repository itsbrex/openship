import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dist/ (this file is bundled into dist/index.js); the API bundle staged by
// build/stage-server.ts lives alongside it at dist/server/.
const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(DIST_DIR, "server");
const OS_DIR = join(homedir(), ".openship");

/** Persist a stable auth secret so sessions survive restarts. */
function ensureAuthSecret(): string {
  const path = join(OS_DIR, "auth-secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

export const upCommand = new Command("up")
  .description("Run the Openship control plane locally (bundled API + embedded database)")
  .option("--port <port>", "Port to listen on", "4000")
  .option("--data-dir <dir>", "Directory for the embedded database")
  .action(async (opts) => {
    const serverEntry = join(SERVER_DIR, "index.js");
    if (!existsSync(serverEntry)) {
      console.error(
        chalk.red("\n  Bundled server not found in this install.") +
          chalk.dim("\n  Reinstall with `npm i -g openship`.\n"),
      );
      process.exit(1);
    }

    const port = String(opts.port || "4000");
    const dataDir: string = opts.dataDir || join(OS_DIR, "data");
    mkdirSync(dataDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: port,
      NODE_ENV: "production",
      // desktop mode → in-process job runner (no Redis) + loopback zero-auth,
      // so a local single-user box needs no PAT over 127.0.0.1.
      DEPLOY_MODE: "desktop",
      OPENSHIP_TARGET: "local",
      OPENSHIP_JOB_RUNNER: "in-process",
      OPENSHIP_ALLOW_ZERO_AUTH: "true",
      PGLITE_DATA_DIR: dataDir,
      OPENSHIP_MIGRATIONS_DIR: join(SERVER_DIR, "migrations"),
      OPENSHIP_PGLITE_ASSETS_DIR: join(SERVER_DIR, "pglite"),
      BETTER_AUTH_SECRET: ensureAuthSecret(),
    };
    delete env.DATABASE_URL;
    delete env.POSTGRES_URL;

    const spinner = ora(`Starting Openship on http://localhost:${port} …`).start();
    const child = spawn(process.execPath, [serverEntry], { env, stdio: ["ignore", "pipe", "pipe"] });

    // Buffer output until healthy; on early exit, surface the tail.
    let buffered = "";
    const buffer = (d: Buffer) => {
      buffered += d.toString();
    };
    child.stdout.on("data", buffer);
    child.stderr.on("data", buffer);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        spinner.fail(`Openship server exited (code ${code})`);
        process.stderr.write(buffered.slice(-2000));
        process.exit(code);
      }
    });

    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    let healthy = false;
    for (let i = 0; i < 60 && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
    }

    if (!healthy) {
      spinner.fail("Openship did not become healthy in time");
      process.stderr.write(buffered.slice(-2000));
      child.kill("SIGTERM");
      process.exit(1);
    }

    spinner.succeed(`Openship running at http://localhost:${port}`);
    console.log(
      chalk.dim(`  API:  http://localhost:${port}/api\n`) +
        chalk.dim(`  Data: ${dataDir}\n`) +
        chalk.dim("  Local access needs no token (loopback). Stop with Ctrl-C.\n"),
    );

    // Switch from buffering to live passthrough for the rest of the run.
    child.stdout.off("data", buffer);
    child.stderr.off("data", buffer);
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));

    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("exit", (code) => process.exit(code ?? 0));
  });
