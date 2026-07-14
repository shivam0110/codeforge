import { cleanRuns } from "../core/run-cleanup.js";
import { repoRoot } from "../git/repo.js";

export async function cleanCommand(options: {
  repo?: string;
  run?: string;
  keep?: number;
  dryRun?: boolean;
}) {
  const root = await repoRoot(options.repo ?? process.cwd());
  const result = await cleanRuns(root, {
    runId: options.run,
    keep: options.keep,
    dryRun: options.dryRun
  });
  const lines = [
    result.removed.length ? `Removed: ${result.removed.join(", ")}` : null,
    result.wouldRemove.length ? `Would remove: ${result.wouldRemove.join(", ")}` : null,
    result.compacted.length ? `Compacted: ${result.compacted.join(", ")}` : null,
    result.wouldCompact.length ? `Would compact: ${result.wouldCompact.join(", ")}` : null,
    result.locked.length ? `Skipped active: ${result.locked.join(", ")}` : null,
    options.keep !== undefined && result.kept.length ? `Kept: ${result.kept.join(", ")}` : null
  ].filter(Boolean);
  console.log(lines.join("\n") || "No inactive ChangeForge runs selected.");
  return result;
}
