import { inspectRun, renderRunInspection, type InspectRunOptions } from "../pipeline/resume.js";

export async function inspectCommand(options: InspectRunOptions & { json?: boolean }) {
  const result = await inspectRun(options);
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : renderRunInspection(result)}\n`);
  if (result.integrityErrors.length) process.exitCode = 1;
  return result;
}
