import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { messageFor } from "./core/errors.js";
import { cleanCommand } from "./commands/clean.js";
import { doctorCommand } from "./commands/doctor.js";
import { executeCommand } from "./commands/execute.js";
import { initCommand } from "./commands/init.js";
import { inspectCommand } from "./commands/inspect.js";
import { loginCommand } from "./commands/login.js";
import { reportCommand } from "./commands/report.js";
import { runCommand } from "./commands/run.js";
import { applyCommand } from "./commands/apply.js";

export function buildProgram() {
  const pkg = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
      "utf8",
    ),
  );
  const program = new Command();
  program
    .name("changeforge")
    .description(
      "Verify Git changes with structured Codex findings and optional Playwright differential evidence.",
    )
    .version(pkg.version);

  program
    .command("init")
    .description(
      "Create strict repository configuration and append owned outputs to .gitignore.",
    )
    .option("--repo <path>", "repository or path inside it")
    .option("--force", "replace an existing ChangeForge config")
    .action(initCommand);

  program
    .command("login")
    .description(
      "Authenticate the Codex CLI without reading or storing its credentials.",
    )
    .option("--device-auth", "use Codex device authentication")
    .option("--status", "print Codex authentication status")
    .action(async (options) => {
      const result = await loginCommand(options);
      if (result.stdout) process.stdout.write(`${result.stdout}\n`);
      if (result.stderr) process.stderr.write(`${result.stderr}\n`);
      if (result.failed) process.exitCode = result.exitCode;
    });

  program
    .command("doctor")
    .description(
      "Report tool versions, Codex auth, project detection, and Playwright browser guidance.",
    )
    .option("--repo <path>", "repository or path inside it")
    .option("--json", "emit the complete diagnostic payload as JSON")
    .action(async (options) => {
      if (!(await doctorCommand(options)).ok) process.exitCode = 1;
    });

  program
    .command("run")
    .description(
      "Review exactly one immutable Git change; generation and command execution require separate consent.",
    )
    .option("--repo <path>", "repository or path inside it")
    .option("--range <range>", "Git two-dot or three-dot range")
    .option(
      "--commit <sha>",
      "commit to compare with its parent or the empty tree",
    )
    .option("--file <path>", "single repository path from the current checkout")
    .option(
      "--working-tree",
      "captured staged, unstaged, and untracked changes",
    )
    .option(
      "--generate",
      "allow Codex to write Playwright coverage inside the generation boundary",
    )
    .option(
      "--execute",
      "run trusted project and configured commands inside the temporary checkout",
    )
    .option(
      "--differential",
      "qualify generated coverage against base and head; runs with execution consent",
    )
    .option(
      "--keep-sandbox",
      "retain the generation/execution checkout; the review checkout is always removed",
    )
    .option(
      "--install-deps",
      "install dependencies with lifecycle scripts disabled; requires --execute",
    )
    .option(
      "--setup-command <cmd>",
      "run a trusted setup command before tests; requires --execute",
    )
    .option(
      "--unit-command <cmd>",
      "trusted unit-test shell command; requires --execute",
    )
    .option(
      "--playwright-command <cmd>",
      "trusted Playwright shell command; requires --execute",
    )
    .option(
      "--allow-source-edits",
      "legacy unsupported option; generated changes are restricted to one sidecar",
    )
    .option("--no-unit", "skip the unit-test phase")
    .option("--no-playwright", "skip Playwright generation and execution")
    .option("--model <model>", "Codex model override")
    .action(async (options) => {
      if ((await runCommand(options)).status === "failed") process.exitCode = 1;
    });

  program
    .command("clean")
    .description("Remove inactive persisted runs and their public evidence.")
    .option("--repo <path>", "repository or path inside it")
    .option("--run <run-id>", "remove one run")
    .option("--keep <number>", "keep the newest runs", Number)
    .option("--dry-run", "show what would be removed")
    .action(async (options) => { await cleanCommand(options); });

  program
    .command("inspect")
    .description(
      "Verify and inspect a persisted run without executing project code.",
    )
    .requiredOption("--run <run-id>", "persisted run id")
    .option("--repo <path>", "repository or path inside it")
    .option("--json", "emit the complete verified run view as JSON")
    .action(async (options) => {
      await inspectCommand({ ...options, runId: options.run });
    });

  program
    .command("execute")
    .description(
      "Resume the stored execution plan in a fresh temporary checkout.",
    )
    .requiredOption("--run <run-id>", "persisted run id")
    .option("--repo <path>", "repository or path inside it")
    .option(
      "--install-deps",
      "install dependencies with lifecycle scripts disabled",
    )
    .option("--force", "repeat a completed execution")
    .action(async (options) => {
      const result = await executeCommand({ ...options, runId: options.run });
      if (result.status === "failed") process.exitCode = 1;
    });

  program
    .command("apply")
    .description(
      "Apply the verified generated overlay without staging or committing.",
    )
    .requiredOption("--run <run-id>", "persisted run id")
    .option("--repo <path>", "repository or path inside it")
    .option("--force", "repeat a completed apply preflight")
    .action(async (options) => {
      await applyCommand({ ...options, runId: options.run });
    });

  program
    .command("report")
    .description("Print or open the public report for a completed run.")
    .option("--repo <path>", "repository or path inside it")
    .option("--open", "open the report in the default browser")
    .option("--no-open", "print the report path without opening it")
    .option(
      "--run <run-id>",
      "specific run id; defaults to the newest public run",
    )
    .action(reportCommand);
  return program;
}

export async function main(argv = process.argv) {
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    console.error(messageFor(error));
    process.exitCode = 1;
  }
}
