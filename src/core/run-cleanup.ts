import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { ChangeForgeError } from "./errors.js";
import { reportDir, resolveContainedPath, runDir } from "./paths.js";
import { loadRunManifest, runHasActiveLocks, runManifestPath, withRunLock } from "./run-store.js";
import { ensureDirContained, existsContained, removeContained } from "../utils/fs.js";

export interface CleanRunsOptions {
  runId?: string;
  keep?: number;
  dryRun?: boolean;
}

export interface CleanRunsResult {
  removed: string[];
  wouldRemove: string[];
  compacted: string[];
  wouldCompact: string[];
  kept: string[];
  locked: string[];
}

interface HistoricalRun {
  runId: string;
  createdAt: number;
  publicDirs: string[];
  claimCurrentPublic: boolean;
  terminal: boolean;
}

export async function cleanRuns(root: string, options: CleanRunsOptions = {}): Promise<CleanRunsResult> {
  validateOptions(root, options);
  const runs = await historicalRuns(root);
  if (options.runId && !runs.some(({ runId }) => runId === options.runId)) {
    throw new ChangeForgeError(`Run ${options.runId} was not found.`, "RUN_NOT_FOUND");
  }
  const selected = options.runId
    ? runs.filter(({ runId }) => runId === options.runId)
    : runs.slice(options.keep ?? 0);
  const selectedIds = new Set(selected.map(({ runId }) => runId));
  const result: CleanRunsResult = {
    removed: [],
    wouldRemove: [],
    compacted: [],
    wouldCompact: [],
    kept: runs.filter(({ runId }) => !selectedIds.has(runId)).map(({ runId }) => runId),
    locked: []
  };
  for (const run of [...selected].reverse()) await cleanRun(root, run, Boolean(options.dryRun), result);
  for (const run of runs.filter(({ runId }) => !selectedIds.has(runId))) {
    await compactRun(root, run, Boolean(options.dryRun), result);
  }
  return result;
}

export function pruneRuns(root: string) {
  return cleanRuns(root, { keep: 10 });
}

async function cleanRun(root: string, run: HistoricalRun, dryRun: boolean, result: CleanRunsResult) {
  if (await runHasActiveLocks(root, run.runId)) {
    result.locked.push(run.runId);
    return;
  }
  if (dryRun) {
    result.wouldRemove.push(run.runId);
    return;
  }
  try {
    await withRunLock(root, run.runId, "run", async () => {
      if (await runHasActiveLocks(root, run.runId, ["run"])) {
        throw new ChangeForgeError(`Run ${run.runId} is active.`, "RUN_OPERATION_LOCKED");
      }
      for (const publicDir of run.publicDirs) await removeContained(root, publicDir);
      await removeContained(root, runDir(root, run.runId));
    });
    await removeEmptyLockDir(root, run.runId);
    result.removed.push(run.runId);
  } catch (error) {
    if (error instanceof ChangeForgeError && error.code === "RUN_OPERATION_LOCKED") {
      result.locked.push(run.runId);
      return;
    }
    throw error;
  }
}

async function compactRun(root: string, run: HistoricalRun, dryRun: boolean, result: CleanRunsResult) {
  if (!run.terminal || !(await needsCompaction(root, run.runId))) return;
  if (await runHasActiveLocks(root, run.runId)) {
    result.locked.push(run.runId);
    return;
  }
  if (dryRun) {
    result.wouldCompact.push(run.runId);
    return;
  }
  let compacted = false;
  try {
    await withRunLock(root, run.runId, "run", async () => {
      if (await runHasActiveLocks(root, run.runId, ["run"])) {
        throw new ChangeForgeError(`Run ${run.runId} is active.`, "RUN_OPERATION_LOCKED");
      }
      const manifest = await loadRunManifest(root, run.runId);
      if (manifest.status === "running" || !(await needsCompaction(root, run.runId))) return;
      await compactLayout(root, run.runId);
      compacted = true;
    });
    await removeEmptyLockDir(root, run.runId);
    if (compacted) result.compacted.push(run.runId);
  } catch (error) {
    if (error instanceof ChangeForgeError && error.code === "RUN_OPERATION_LOCKED") {
      result.locked.push(run.runId);
      return;
    }
    throw error;
  }
}

async function needsCompaction(root: string, runId: string) {
  const machine = runDir(root, runId);
  const entries = await fs.readdir(await ensureDirContained(root, machine));
  if (entries.some((entry) => !["artifacts", "run-manifest.v1.json"].includes(entry))) return true;
  const artifacts = path.join(machine, "artifacts");
  if (!(await existsContained(root, artifacts))) return true;
  const artifactEntries = await fs.readdir(await ensureDirContained(root, artifacts));
  if (artifactEntries.some((entry) => entry !== "immutable")) return true;
  return !(await existsContained(root, path.join(artifacts, "immutable")));
}

async function compactLayout(root: string, runId: string) {
  const machine = await ensureDirContained(root, runDir(root, runId));
  const artifacts = await ensureDirContained(root, path.join(machine, "artifacts"));
  await ensureDirContained(root, path.join(artifacts, "immutable"));
  for (const entry of await fs.readdir(machine)) {
    if (!["artifacts", "run-manifest.v1.json"].includes(entry)) {
      await removeContained(root, path.join(machine, entry));
    }
  }
  for (const entry of await fs.readdir(artifacts)) {
    if (entry !== "immutable") await removeContained(root, path.join(artifacts, entry));
  }
}

async function removeEmptyLockDir(root: string, runId: string) {
  await fs.rmdir(path.join(root, ".changeforge", "locks", runId)).catch((error) => {
    if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) throw error;
  });
}

async function historicalRuns(root: string) {
  const runs = new Map<string, HistoricalRun>();
  const runsRoot = path.join(root, ".changeforge", "runs");
  if (await existsContained(root, runsRoot)) {
    const safeRoot = await ensureDirContained(root, runsRoot);
    const entries = await fs.readdir(safeRoot, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name !== ".locks")
      .map(async (entry) => {
      const machineDir = path.join(safeRoot, entry.name);
      const fallback = (await fs.lstat(machineDir)).mtimeMs;
      const manifest = await loadRunManifest(root, entry.name).catch(() => null);
      if (!manifest || manifest.runId !== entry.name) {
        runs.set(entry.name, {
          runId: entry.name,
          createdAt: fallback,
          publicDirs: [],
          claimCurrentPublic: false,
          terminal: false
        });
        return;
      }
      runs.set(entry.name, {
        runId: entry.name,
        createdAt: Date.parse(manifest.createdAt),
        publicDirs: [reportDir(root, manifest.config.docsDir, entry.name)],
        claimCurrentPublic: true,
        terminal: manifest.status !== "running"
      });
    }));
  }
  await addCurrentPublicRuns(root, runs);
  return [...runs.values()].sort((left, right) =>
    right.createdAt - left.createdAt || right.runId.localeCompare(left.runId)
  );
}

async function addCurrentPublicRuns(root: string, runs: Map<string, HistoricalRun>) {
  const config = await loadConfig(root, { required: false }).catch(() => null);
  if (!config) return;
  const publicRoot = resolveContainedPath(root, config.docsDir, "docsDir");
  if (!(await existsContained(root, publicRoot))) return;
  const entries = await fs.readdir(await ensureDirContained(root, publicRoot), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeRunId(root, entry.name)) continue;
    const existing = runs.get(entry.name);
    if (existing && !existing.claimCurrentPublic) continue;
    const publicDir = path.join(publicRoot, entry.name);
    if (!(await isPublicRun(root, publicDir))) continue;
    if (existing) {
      if (!existing.publicDirs.includes(publicDir)) existing.publicDirs.push(publicDir);
      continue;
    }
    runs.set(entry.name, {
      runId: entry.name,
      createdAt: (await fs.lstat(publicDir)).mtimeMs,
      publicDirs: [publicDir],
      claimCurrentPublic: true,
      terminal: false
    });
  }
}

async function isPublicRun(root: string, publicDir: string) {
  const markers = [
    path.join(publicDir, "code-review.md"),
    path.join(publicDir, "playwright-report", "index.html")
  ];
  for (const marker of markers) {
    if (await existsContained(root, marker).catch(() => false)) return true;
  }
  const entries = await fs.readdir(await ensureDirContained(root, publicDir), { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"));
}

function safeRunId(root: string, runId: string) {
  try {
    runManifestPath(root, runId);
    return true;
  } catch {
    return false;
  }
}

function validateOptions(root: string, options: CleanRunsOptions) {
  if (options.runId) runManifestPath(root, options.runId);
  if (options.runId && options.keep !== undefined) {
    throw new ChangeForgeError("Use either --run or --keep, not both.", "CLEAN_OPTIONS_INVALID");
  }
  if (options.keep !== undefined && (!Number.isSafeInteger(options.keep) || options.keep < 0)) {
    throw new ChangeForgeError("--keep must be a non-negative integer.", "CLEAN_OPTIONS_INVALID");
  }
}

function isCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
