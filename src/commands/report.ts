import path from "node:path";
import open from "open";
import { loadConfig } from "../core/config.js";
import { ChangeForgeError } from "../core/errors.js";
import { resolveContainedPath } from "../core/paths.js";
import { repoRoot } from "../git/repo.js";
import { existsContained, newestDir } from "../utils/fs.js";

export async function reportCommand(options: { repo?: string; run?: string; open?: boolean }) {
  const root = await repoRoot(options.repo ?? process.cwd());
  const config = await loadConfig(root);
  const reportRoot = resolveContainedPath(root, config.docsDir, "docsDir");
  const runId = options.run ?? await newestDir(root, reportRoot);
  if (!runId) throw new ChangeForgeError("No ChangeForge runs found.", "NO_RUNS");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new ChangeForgeError("Invalid ChangeForge run id.", "RUN_ID_INVALID");
  }
  const index = path.join(reportRoot, runId, "playwright-report", "index.html");
  if (!(await existsContained(root, index))) {
    const review = path.join(reportRoot, runId, "code-review.md");
    if (await existsContained(root, review)) {
      console.log(`No Playwright report generated for run ${runId}. Code review: ${review}`);
      return;
    }
    throw new ChangeForgeError(`No Playwright report found at ${index}.`, "PLAYWRIGHT_REPORT_MISSING");
  }
  if (options.open === true) await open(index);
  console.log(index);
}
