import { ChangeForgeError } from "../core/errors.js";
import type { CodexResult, CodexTask } from "../core/types.js";
import { runCommand } from "../runners/command.js";
import { assertSafeWritePath, ensureDirContained, readTextContained } from "../utils/fs.js";
import path from "node:path";
import type { CodexAdapter } from "./adapter.js";

export class CodexCliAdapter implements CodexAdapter {
  async assertLoggedIn() {
    const help = await runCommand("codex", ["exec", "--help"], { check: false, timeoutMs: 10000 });
    if (help.failed) {
      throw new ChangeForgeError(
        `Codex CLI is unavailable: ${firstLine(help.stderr || help.stdout) || help.errorCode || "cannot start"}.`,
        "CODEX_CLI_UNAVAILABLE",
        "Install or repair it with:\n  npm install -g @openai/codex@latest"
      );
    }
    if (!`${help.stdout}\n${help.stderr}`.includes("--ephemeral")) {
      throw new ChangeForgeError(
        "Codex CLI does not support ephemeral exec sessions.",
        "CODEX_CLI_INCOMPATIBLE",
        "Update it with:\n  npm install -g @openai/codex@latest"
      );
    }
    const result = await runCommand("codex", ["login", "status"], { check: false, timeoutMs: 10000 });
    if (result.failed) {
      throw new ChangeForgeError("Codex is not authenticated.", "CODEX_NOT_LOGGED_IN", "Run:\n  changeforge login\n\nOr:\n  changeforge login --device-auth");
    }
  }

  async login(options: { deviceAuth?: boolean; status?: boolean }) {
    const args = options.status ? ["login", "status"] : ["login", ...(options.deviceAuth ? ["--device-auth"] : [])];
    return runCommand("codex", args, { check: false, timeoutMs: options.status ? 10000 : undefined });
  }

  async runTask(task: CodexTask): Promise<CodexResult> {
    await this.assertLoggedIn();
    await ensureDirContained(task.artifactRoot, path.dirname(task.outputFile));
    await assertSafeWritePath(task.artifactRoot, task.outputFile);
    if (task.logFile) await ensureDirContained(task.artifactRoot, path.dirname(task.logFile));
    const result = await runCommand("codex", buildCodexExecArgs(task), {
      cwd: task.cwd,
      input: task.prompt,
      check: false,
      stream: task.stream ?? false,
      logFile: task.logFile,
      logRoot: task.artifactRoot,
      timeoutMs: task.timeoutMs
    });
    if (result.timedOut) {
      const detail = task.logFile ? ` See ${task.logFile}.` : "";
      throw new ChangeForgeError(`Codex task timed out after ${task.timeoutMs}ms.${detail}`, "CODEX_TASK_TIMEOUT");
    }
    if (result.failed) {
      const detail = task.logFile ? ` See ${task.logFile}.` : `\n${result.stderr || result.stdout}`;
      throw new ChangeForgeError(`Codex task failed.${detail}`, "CODEX_TASK_FAILED");
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputFile: task.outputFile
    };
  }
}

export function buildCodexExecArgs(task: CodexTask) {
  const args = [
    "--ask-for-approval",
    "never"
  ];
  if (task.reasoning) args.push("-c", `model_reasoning_effort="${task.reasoning}"`);
  args.push(
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    ...(task.ignoreRules === true ? ["--ignore-rules"] : []),
    "--cd",
    task.cwd,
    "--sandbox",
    task.sandbox,
    "--output-last-message",
    task.outputFile,
    "--color",
    "never"
  );
  if (task.json) args.push("--json");
  if (task.model) args.push("--model", task.model);
  args.push("-");
  return args;
}

export async function readCodexOutput(root: string, file: string) {
  return readTextContained(root, file);
}

function firstLine(value: string) {
  return value.trim().split(/\r?\n/)[0] ?? "";
}
