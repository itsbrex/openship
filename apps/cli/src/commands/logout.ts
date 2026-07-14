import { Command } from "commander";
import chalk from "chalk";
import { clearToken, getActiveContext, getContext } from "../lib/config";

export const logoutCommand = new Command("logout")
  .description("Remove the stored Openship token")
  .option("--context <name>", "Log out of a specific context (defaults to active)")
  .action((opts) => {
    const name: string = opts.context || getActiveContext();
    if (!getContext(name).token) {
      console.log(chalk.dim(`\n  Not logged in (context "${name}").\n`));
      return;
    }
    clearToken(name);
    console.log(
      chalk.green(`\n  Logged out`) +
        chalk.dim(` (context "${name}"). Token removed from ~/.openship/config.json\n`),
    );
  });
