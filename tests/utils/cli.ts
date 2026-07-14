import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execa } from "execa";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export async function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; passthrough?: boolean } = {}
) {
  if (options.passthrough) {
    const [, cmd, ...rest] = args;
    return execa(cmd, rest, { cwd: options.cwd, env: options.env });
  }
  return execa(process.execPath, ["--import", "tsx", join(root, "src/bin.ts"), ...args], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env }
  });
}

export async function runCliResult(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execa(process.execPath, ["--import", "tsx", join(root, "src/bin.ts"), ...args], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    reject: false
  });
}
