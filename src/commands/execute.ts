import { executeRun, type ExecuteRunOptions } from "../pipeline/resume.js";

export async function executeCommand(options: ExecuteRunOptions) {
  const result = await executeRun(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
