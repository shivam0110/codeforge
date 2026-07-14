import path from "node:path";
import type { ProjectDetection, RunContext } from "../core/types.js";
import type { ResolvedChangeSet } from "../git/change-set.js";
import { readJsonContained, writeJsonContained, writeTextContained } from "../utils/fs.js";
import { buildChangeReport } from "./change-report.js";
import { collectFileSnapshots } from "./file-snapshots.js";

export type CollectedContext = Awaited<ReturnType<typeof collectContext>>;

export async function collectContext(context: RunContext, change: ResolvedChangeSet, project: ProjectDetection) {
  const diff = change.diff;
  const snapshots = await collectFileSnapshots(context.workRoot, diff);
  const contextDir = path.join(context.runDir, "context");
  await writeTextContained(context.originalRoot, path.join(contextDir, "diff.patch"), diff.patch);
  await writeTextContained(context.originalRoot, path.join(contextDir, "diff-stat.txt"), diff.stat);
  await writeTextContained(context.originalRoot, path.join(contextDir, "name-status.txt"), diff.nameStatus);
  await writeJsonContained(context.originalRoot, path.join(contextDir, "changed-files.json"), diff.changedFiles);
  await writeJsonContained(context.originalRoot, path.join(contextDir, "file-snapshots.json"), snapshots);
  await writeJsonContained(context.originalRoot, path.join(contextDir, "package.json"), await readJsonContained(context.workRoot, path.join(context.workRoot, "package.json"), null));
  await writeJsonContained(context.originalRoot, path.join(contextDir, "project-detection.json"), project);
  const report = buildChangeReport(context, diff, project, snapshots);
  return { diff, project, snapshots, report };
}
