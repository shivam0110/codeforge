import { ChangeForgeError } from "../core/errors.js";
import { runShell } from "./command.js";

export async function runSetupCommand(
  root: string,
  command: string,
  logFile: string,
  logRoot: string,
  timeoutMs: number
) {
  const result = await runShell(command, { cwd: root, logFile, logRoot, stream: true, timeoutMs });
  if (result.failed) {
    throw new ChangeForgeError(`Setup command failed (${result.exitCode}).`, "SETUP_COMMAND_FAILED");
  }
  return result;
}
