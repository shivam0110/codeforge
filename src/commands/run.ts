import { runPipeline, type RunOptions } from "../pipeline/run.js";

export async function runCommand(options: RunOptions) {
  return runPipeline(options);
}
