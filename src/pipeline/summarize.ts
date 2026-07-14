import path from "node:path";
import type { FindingsArtifactsV1, FindingSeverity } from "../core/findings.js";
import type { ChangeForgeConfig, DiffContext, FileSnapshot, ProjectDetection, RunContext } from "../core/types.js";
import type { DifferentialArtifactV1 } from "./differential-workflow.js";
import { saveChangedFiles, savePatch, type PatchBaseline } from "../git/patch.js";
import type { GeneratedOverlayV1 } from "../git/generated-overlay.js";
import {
  copyDirectoryContained, existsContained, readTextContained, removeContained, writeJsonContained, writeTextContained
} from "../utils/fs.js";
import { runtimePlaywrightReportDir } from "./run-tests.js";

type Coverage = { status: "skipped" | "unavailable" | "executed" | "generated"; reason?: string; targetFile?: string };
export type RunStatus = "passed" | "partial" | "failed";
type RunStatusResult = { status: RunStatus; statusReason: string };

export async function summarizeRun(
  context: RunContext,
  diff: DiffContext,
  project: ProjectDetection,
  results: { name: string; command: string; result: { exitCode: number } }[],
  snapshots: FileSnapshot[] = [],
  _config: ChangeForgeConfig,
  baseline: PatchBaseline,
  coverage: Coverage,
  playwrightSource: string | null = null,
  findingArtifacts?: FindingsArtifactsV1,
  differential?: DifferentialArtifactV1 | null,
  generatedOverlay?: GeneratedOverlayV1 | null
) {
  const artifacts = path.join(context.runDir, "artifacts");
  const patch = path.join(artifacts, "patch.diff");
  if (coverage.status === "generated") await copyGeneratedTestArtifact(context, generatedOverlay);
  const patchBytes = await savePatch(context.workRoot, baseline, patch);
  const generatedFiles = await saveChangedFiles(context.workRoot, baseline, path.join(artifacts, "generated-files.json"));
  const status = differentialStatus(runStatus(results, snapshots, coverage), differential);
  const playwrightReport = await publishPlaywrightReport(context, playwrightSource);
  const summary = {
    runId: context.runId,
    input: context.input,
    resolved: { baseSha: context.baseSha, headSha: context.headSha },
    consent: { generate: context.generate, execute: context.execute },
    coverage: { status: coverage.status, reason: coverage.reason, targetFile: coverage.targetFile },
    findings: findingArtifacts ? summarizeFindings(findingArtifacts) : undefined,
    differential: differential ? summarizeDifferential(differential) : undefined,
    ...status,
    project,
    changedFiles: diff.changedFiles,
    generatedFiles,
    commands: results.map((item) => ({ name: item.name, command: item.command })),
    results: results.map((item) => ({ name: item.name, exitCode: item.result.exitCode })),
    playwrightReport,
    patch,
    patchBytes
  };
  await writeJsonContained(context.originalRoot, path.join(artifacts, "summary.json"), summary);
  return summary;
}

function summarizeDifferential(artifact: DifferentialArtifactV1) {
  const side = (value: DifferentialArtifactV1["result"]["base"]) => ({
    outcome: value.outcome,
    counts: value.counts,
    durationMs: value.durationMs,
    logPath: value.logPath
  });
  return {
    schemaVersion: artifact.schemaVersion,
    classification: artifact.result.classification,
    reason: artifact.result.reason,
    generatedTest: artifact.generatedTest,
    base: side(artifact.result.base),
    head: side(artifact.result.head)
  };
}

function differentialStatus(status: RunStatusResult, artifact?: DifferentialArtifactV1 | null): RunStatusResult {
  if (!artifact || artifact.result.classification === "regression-proof" || status.status === "failed") return status;
  if (artifact.result.classification === "no-discrimination") {
    return { status: "partial", statusReason: artifact.result.reason };
  }
  return { status: "failed", statusReason: artifact.result.reason };
}

function summarizeFindings({ document, artifact, report }: FindingsArtifactsV1) {
  const bySeverity: Record<FindingSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of document.findings) bySeverity[finding.severity] += 1;
  return { schemaVersion: document.schemaVersion, total: document.findings.length, bySeverity, artifact, report };
}

async function publishPlaywrightReport(context: RunContext, source: string | null) {
  const target = path.join(context.reportDir, "playwright-report");
  await removeContained(context.originalRoot, target);
  if (!source || !(await existsContained(context.workRoot, path.join(source, "index.html")))) return null;
  await copyDirectoryContained(context.workRoot, source, context.originalRoot, target);
  return path.join(target, "index.html");
}

export async function writePartialRunSummary(
  context: RunContext,
  error: unknown,
  findings?: FindingsArtifactsV1,
  generatedOverlay?: GeneratedOverlayV1 | null
) {
  if (generatedOverlay) await copyGeneratedTestArtifact(context, generatedOverlay);
  const message = error instanceof Error ? error.message : String(error);
  const playwrightReport = await publishPlaywrightReport(context, runtimePlaywrightReportDir(context));
  const summary = {
    runId: context.runId,
    input: context.input,
    status: "failed",
    statusReason: `Run did not complete: ${message}`,
    findings: findings ? summarizeFindings(findings) : undefined,
    playwrightReport,
    error: { message }
  };
  await writeJsonContained(context.originalRoot, path.join(context.runDir, "artifacts/summary.json"), summary);
  return summary;
}

async function copyGeneratedTestArtifact(context: RunContext, overlay?: GeneratedOverlayV1 | null) {
  const target = context.generatedTestFile;
  const out = path.join(context.reportDir, path.basename(target));
  if (overlay) {
    const relative = path.relative(context.workRoot, target).split(path.sep).join("/");
    const entry = overlay.entries.find((item) => item.path === relative);
    if (entry?.after?.kind === "file") {
      await writeTextContained(context.originalRoot, out, Buffer.from(entry.after.data, "base64"));
    }
    return;
  }
  if (!(await existsContained(context.workRoot, target))) return;
  if (path.resolve(out) === path.resolve(target)) return;
  await writeTextContained(context.originalRoot, out, await readTextContained(context.workRoot, target));
}

export function runStatus(
  results: { name?: string; result: { exitCode: number } }[],
  snapshots: FileSnapshot[] = [],
  coverage?: Coverage
): RunStatusResult {
  if (results.some((item) => item.result.exitCode !== 0)) return { status: "failed", statusReason: "One or more commands failed." };
  if (snapshots.some((item) => item.kind === "gitlink" && !item.initialized)) {
    return { status: "partial", statusReason: "One or more changed submodules were not initialized." };
  }
  if (coverage?.status === "unavailable" && !results.some((item) => item.name === "playwright")) {
    return { status: "partial", statusReason: coverage.reason ?? "Playwright coverage is unavailable." };
  }
  if (!results.length) return { status: "partial", statusReason: "No test commands ran." };
  if (!results.some((item) => item.name === "unit" || item.name === "playwright")) {
    return { status: "partial", statusReason: "No trusted test command ran." };
  }
  return { status: "passed", statusReason: "All executed test commands passed." };
}
