import { applyRun, type ApplyRunOptions } from "../pipeline/resume.js";

export async function applyCommand(options: ApplyRunOptions) {
  const result = await applyRun(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
