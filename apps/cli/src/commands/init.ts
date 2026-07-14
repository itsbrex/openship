/**
 * `openship init` — link the current directory to an Openship project by
 * writing .openship/project.json. Later commands (e.g. deploy) read this file
 * to know which project to act on without a flag.
 *
 * Projects come from GET /api/projects (project.controller.ts:list), the
 * standard paginated envelope { data, total, page, perPage }. Each row's `id`
 * is the project identifier (schema/project.ts — "proj_…"); we persist that
 * plus name/slug and a default environment so deploy has everything it needs.
 */
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { paginate, ApiError } from "../lib/api-client";
import { getActiveContext } from "../lib/config";
import { err, info, isJsonMode, ok, printJson } from "../lib/output";

interface ProjectRow {
  id: string;
  name?: string;
  slug?: string;
  source?: string;
}

interface ProjectLink {
  projectId: string;
  name?: string;
  slug?: string;
  context: string;
  defaults: { environment: string };
}

export const initCommand = new Command("init")
  .description("Link the current directory to an Openship project (.openship/project.json)")
  .option("--project <id>", "Project id to link (skips the picker)")
  .option("--environment <name>", "Default deploy environment", "production")
  .option("--dir <path>", "Directory to initialize", process.cwd())
  .option("--force", "Overwrite an existing project link")
  .option("-y, --yes", "Non-interactive: fail instead of prompting")
  .action(async (opts) => {
    const root: string = opts.dir || process.cwd();
    const linkDir = join(root, ".openship");
    const linkPath = join(linkDir, "project.json");

    if (existsSync(linkPath) && !opts.force) {
      err(`Already linked (${linkPath}). Re-run with --force to overwrite.`);
      process.exit(1);
    }

    let projectId: string | undefined = opts.project;
    let picked: ProjectRow | undefined;

    try {
      if (!projectId) {
        const projects: ProjectRow[] = [];
        for await (const p of paginate<ProjectRow>("/projects", { perPage: 100 })) {
          projects.push(p);
        }

        if (projects.length === 0) {
          err("No projects found for the active context. Create one in the dashboard first.");
          process.exit(1);
        }

        if (opts.yes) {
          err("Multiple projects available; pass --project <id> in non-interactive mode.");
          process.exit(1);
        }

        info("\n  Select a project to link:\n");
        projects.forEach((p, i) => {
          const label = p.name ?? p.slug ?? p.id;
          output.write(`  ${String(i + 1).padStart(2)}. ${label}  ${p.id}\n`);
        });
        const rl = createInterface({ input, output });
        const answer = (await rl.question("\n  Number or project id: ")).trim();
        rl.close();

        const asIndex = Number(answer);
        if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= projects.length) {
          picked = projects[asIndex - 1];
        } else {
          picked = projects.find((p) => p.id === answer || p.slug === answer);
        }
        if (!picked) {
          err("No matching project.");
          process.exit(1);
        }
        projectId = picked.id;
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      err(`Couldn't list projects: ${msg}`);
      process.exit(1);
    }

    const link: ProjectLink = {
      projectId: projectId!,
      ...(picked?.name ? { name: picked.name } : {}),
      ...(picked?.slug ? { slug: picked.slug } : {}),
      context: getActiveContext(),
      defaults: { environment: opts.environment || "production" },
    };

    mkdirSync(linkDir, { recursive: true });
    writeFileSync(linkPath, JSON.stringify(link, null, 2) + "\n");

    if (isJsonMode()) {
      printJson({ path: linkPath, link });
      return;
    }
    ok(`\n  Linked ${link.name ?? link.projectId} → ${linkPath}\n`);
  });
