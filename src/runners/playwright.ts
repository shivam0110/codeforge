import type { CommandSpec } from "../core/types.js";
import { runSpec } from "./command.js";

export async function runPlaywright(
  root: string,
  command: CommandSpec,
  logFile: string,
  logRoot: string,
  timeoutMs: number,
  sourceEnv: NodeJS.ProcessEnv = process.env
) {
  const env: NodeJS.ProcessEnv = { ...sourceEnv, FORCE_COLOR: "0" };
  delete env.NO_COLOR;
  return runSpec(command, { cwd: root, env, extendEnv: false, check: false, logFile, logRoot, stream: true, timeoutMs });
}
