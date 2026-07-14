import { ChangeForgeError } from "../core/errors.js";
import { realpath } from "node:fs/promises";
import { runCommand } from "../runners/command.js";
import { isolatedGitEnv } from "./env.js";

export async function repoRoot(cwd: string) {
  const result = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    check: false,
    timeoutMs: 10000,
    env: isolatedGitEnv(),
    extendEnv: false
  });
  if (result.failed) {
    throw new ChangeForgeError("Not a Git repository.", "NOT_A_GIT_REPO", "Run ChangeForge inside a Git repo or pass --repo <path>.");
  }
  return realpath(result.stdout.trim());
}
