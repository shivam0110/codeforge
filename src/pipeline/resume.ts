import path from "node:path";
import { execa } from "execa";
import type { FindingsDocumentV1, FindingSeverity } from "../core/findings.js";
import { ChangeForgeError } from "../core/errors.js";
import type { RunManifestV1 } from "../core/run-manifest.js";
import { pruneRuns } from "../core/run-cleanup.js";
import {
  loadRunManifest, readVerifiedArtifact, verifyArtifacts, withRunLock
} from "../core/run-store.js";
import {
  optionalRunPath, reportDir as makeReportDir, runDir as makeRunDir, testsDir as makeTestsDir
} from "../core/paths.js";
import type { ProjectDetection, RunContext } from "../core/types.js";
import {
  materializeChangeSet, resolveChangeSet, restoreChangeSet, snapshotChangeSet,
  validateChangeSnapshotV1, type ChangeSnapshotV1, type ResolvedChangeSet
} from "../git/change-set.js";
import { isolatedGitEnv } from "../git/env.js";
import {
  applyGeneratedOverlay, generatedOverlayState, replayGeneratedOverlay,
  validateGeneratedOverlayV1, type GeneratedOverlayV1
} from "../git/generated-overlay.js";
import { createPatchBaseline } from "../git/patch.js";
import { repoRoot } from "../git/repo.js";
import { removeSandbox, sandboxPath } from "../git/sandbox.js";
import { detectProject } from "../project/detect.js";
import { linkLocalDependencies } from "../project/dependencies.js";
import { installDevDeps } from "../runners/npm.js";
import { runSetupCommand } from "../runners/setup.js";
import { existsContained, writeJsonContained } from "../utils/fs.js";
import { collectContext } from "./collect-context.js";
import { createInputIntegrityGuard } from "./input-integrity.js";
import {
  runDifferentialWorkflow, validateDifferentialArtifactV1, validateDifferentialBinding,
  type DifferentialArtifactV1
} from "./differential-workflow.js";
import { runTests, runtimePlaywrightReportDir, type TestResult } from "./run-tests.js";
import {
  finishRun, grant, recordExistingArtifacts, recordRunArtifact, startPhase, completePhase,
  failActivePhase, failRun, recoverRunningPhase, verifyGeneratedOverlay, type RunState
} from "./run-state.js";
import { summarizeRun, writePartialRunSummary } from "./summarize.js";

export type InspectRunOptions = { repo?: string; runId: string };
export type ExecuteRunOptions = InspectRunOptions & { installDeps?: boolean; force?: boolean };
export type ApplyRunOptions = InspectRunOptions & { force?: boolean };

export async function inspectRun(options: InspectRunOptions) {
  const root = await repoRoot(options.repo ?? process.cwd());
  const manifest = await loadRunManifest(root, options.runId);
  const artifacts: typeof manifest.artifacts = {};
  const bytes = new Map<string, Buffer>();
  const integrityErrors: { artifact: string; code: string; message: string }[] = [];
  for (const name of Object.keys(manifest.artifacts).sort()) {
    try {
      const verified = await readVerifiedArtifact(root, manifest, name);
      artifacts[name] = verified.artifact;
      bytes.set(name, verified.bytes);
    } catch (error) {
      integrityErrors.push(integrityError(name, error));
    }
  }
  if (artifacts.snapshot && artifacts.snapshot.sha256 !== manifest.resolved.changeSha256) {
    integrityErrors.push({ artifact: "snapshot", code: "RUN_ARTIFACT_INVALID", message: "Snapshot digest does not match the resolved change." });
  }
  const consume = <T>(name: string, validate: (value: unknown) => T): T | null => {
    const source = bytes.get(name);
    if (!source) return null;
    try {
      return validate(parseJson(source, name));
    } catch (error) {
      integrityErrors.push(integrityError(name, error));
      return null;
    }
  };
  consume("snapshot", validateChangeSnapshotV1);
  const document = consume("findings", (value) => validateFindings(value as FindingsDocumentV1));
  const generated = consume("overlay", validateGeneratedOverlayV1);
  const summary = consume("summary", (value) => validateSummary(value, manifest));
  consume("generatedFiles", (value) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) integrity("Generated-files artifact is invalid.");
    return value;
  });
  consume("executeError", validateExecuteError);
  let differential = consume("differential", validateDifferentialArtifactV1);
  if (manifest.plan.differential && manifest.phases.differential.status === "completed" && !differential) {
    integrityErrors.push({ artifact: "differential", code: "RUN_ARTIFACT_INVALID", message: "Completed differential evidence is missing." });
  }
  if (manifest.phases.differential.status === "completed" && !manifest.artifacts.differential) {
    integrityErrors.push({
      artifact: "differential",
      code: "RUN_ARTIFACT_INVALID",
      message: "Completed differential evidence is missing."
    });
  }
  if (differential) {
    try {
      differential = validateDifferentialBinding(differential, generated);
      validateDifferentialState(manifest, summary, differential);
    } catch (error) {
      integrityErrors.push(integrityError("differential", error));
      differential = null;
    }
  }
  const bySeverity: Record<FindingSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of document?.findings ?? []) bySeverity[finding.severity] += 1;
  return {
    manifest,
    findings: { total: document?.findings.length ?? 0, bySeverity, document },
    generatedPaths: generated?.entries.map((entry) => entry.path) ?? [],
    plannedCommands: {
      setup: manifest.plan.setupCommand,
      unit: manifest.plan.unitCommand,
      playwright: manifest.plan.playwrightCommand
    },
    capabilities: manifest.capabilities,
    artifacts,
    summary,
    differential,
    integrityErrors
  };
}

export function renderRunInspection(view: Awaited<ReturnType<typeof inspectRun>>) {
  const phases = Object.entries(view.manifest.phases).map(([name, phase]) => {
    const reason = phase.reason ? `, reason=${terminalText(phase.reason)}` : "";
    return `${name}=${phase.status} (attempts=${phase.attempts}${reason})`;
  }).join(", ");
  const commands = Object.entries(view.plannedCommands)
    .map(([name, command]) => `${name}=${command ? terminalText(command) : name === "setup" ? "none" : "default"}`)
    .join(", ");
  const capabilities = Object.entries(view.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "none";
  const artifacts = Object.entries(view.artifacts)
    .map(([name, artifact]) => `${name}=${terminalText(artifact.path)} (${artifact.bytes} bytes, ${artifact.sha256.slice(0, 12)}…)`)
    .join(", ") || "none";
  return [
    `Run ${view.manifest.runId}: ${view.manifest.status}`,
    `Phases: ${phases}`,
    `Findings: ${view.findings.total}`,
    `Generated: ${view.generatedPaths.length ? view.generatedPaths.join(", ") : "none"}`,
    `Differential: ${view.differential?.result.classification ?? (view.manifest.plan.differential ? "planned" : "not requested")}`,
    `Commands: ${commands}`,
    `Capabilities: ${capabilities}`,
    `Artifacts: ${artifacts}`,
    `Integrity errors: ${view.integrityErrors.length ? view.integrityErrors.map((error) => `${error.artifact}: ${terminalText(error.message)}`).join("; ") : "none"}`
  ].join("\n");
}

export async function executeRun(options: ExecuteRunOptions) {
  const root = await repoRoot(options.repo ?? process.cwd());
  try {
    return await withRunLock(root, options.runId, "run", async () => executeLocked(root, options));
  } finally {
    await pruneRuns(root).catch(() => undefined);
  }
}

export async function applyRun(options: ApplyRunOptions) {
  const root = await repoRoot(options.repo ?? process.cwd());
  try {
    return await withRunLock(root, options.runId, "run", async () => applyLocked(root, options));
  } finally {
    await pruneRuns(root).catch(() => undefined);
  }
}

async function executeLocked(root: string, options: ExecuteRunOptions) {
  let manifest = await loadRunManifest(root, options.runId);
  assertExecuteEligibility(manifest);
  const stale = staleOperation(manifest, "execute", Boolean(options.force));
  if (manifest.phases.execute.status === "completed" && !options.force) {
    await validateStoredArtifacts(root, manifest);
    return validateSummary(parseJson((await readVerifiedArtifact(root, manifest, "summary")).bytes, "summary"), manifest);
  }
  await verifyArtifacts(root, manifest);
  const snapshotRead = await readVerifiedArtifact(root, manifest, "snapshot");
  if (snapshotRead.artifact.sha256 !== manifest.resolved.changeSha256) integrity("Snapshot digest does not match the resolved change.");
  const snapshot = parseJson<ChangeSnapshotV1>(snapshotRead.bytes, "snapshot");
  const overlay = manifest.artifacts.overlay
    ? validateGeneratedOverlayV1(parseJson((await readVerifiedArtifact(root, manifest, "overlay")).bytes, "overlay"))
    : null;
  const hasOverlay = Boolean(overlay?.entries.length);
  const workRoot = await sandboxPath(root);
  const state: RunState = { root, manifest, active: null };
  let context: RunContext | null = null;
  let baseline: Awaited<ReturnType<typeof createPatchBaseline>> | null = null;
  let failure: unknown;
  let output: Awaited<ReturnType<typeof summarizeRun>> | undefined;
  try {
    if (stale) {
      const recovered = new ChangeForgeError("Recovered a stale execute attempt with --force.", "STALE_EXECUTE_RECOVERED");
      await recoverRunningPhase(state, stale, recovered.message);
      if (stale === "execute") await recordExecuteError(state, recovered);
    }
    await grant(state, { execute: true, installDependencies: Boolean(options.installDeps) || manifest.capabilities.installDependencies });
    await startPhase(state, "execute", Boolean(options.force));
    manifest = state.manifest;
    const change = await restoreChangeSet(root, snapshot);
    await materializeChangeSet(change, workRoot);
    context = await resumeContext(root, workRoot, manifest, change, hasOverlay);
    baseline = await createPatchBaseline(workRoot, context.runDir, root);
    if (hasOverlay) await replayGeneratedOverlay(workRoot, overlay);
    const verifyOverlay = async () => { if (hasOverlay) await verifyGeneratedOverlay(workRoot, overlay!); };
    let project = await detectProject(workRoot);
    if (options.installDeps) {
      if (!project.packageManager || !project.hasPackageJson) {
        throw new ChangeForgeError("Dependency installation requires a package.json and supported package manager.", "PACKAGE_MANAGER_MISSING");
      }
      await verifyOverlay();
      await installDevDeps(workRoot, project.packageManager, project.missingRecommendedDeps, manifest.config.commandTimeoutMs);
      await verifyOverlay();
      project = await detectProject(workRoot);
    } else if (project.packageManager) {
      const local = await existsContained(root, path.join(root, "node_modules"));
      const directPlaywright = manifest.plan.playwright && project.hasPlaywright && !manifest.plan.playwrightCommand
        && (hasOverlay || context.e2eTestFileExists);
      if (local || manifest.plan.setupCommand || directPlaywright || manifest.plan.differential) {
        await linkLocalDependencies(root, workRoot, project.packageManager);
      }
    }
    const collected = await collectContext(context, change, project);
    const inputs = createInputIntegrityGuard(workRoot, () => baseline!.ignored);
    await inputs.refresh();
    baseline.ignored.push(...inputs.outputRoots());
    const verify = async () => {
      await verifyOverlay();
      await inputs.verify();
    };
    if (manifest.plan.setupCommand) {
      await verify();
      await runSetupCommand(
        workRoot,
        manifest.plan.setupCommand,
        path.join(context.runDir, "logs/setup-resume.log"),
        root,
        manifest.config.commandTimeoutMs
      );
      await verify();
    }
    const stored = await runStoredPlan(context, project, manifest, hasOverlay, verify);
    const results = stored.results;
    if (results.some((item) => item.result.exitCode !== 0)) await failActivePhase(state, "One or more commands failed.");
    else await completePhase(state, "execute");
    const differential = await resumeDifferentialPhase(
      state, context, change, project, overlay, options, inputs.outputRoots()
    );
    const findings = await findingsArtifacts(root, state.manifest, context);
    const coverage = hasOverlay
      ? { status: "generated" as const, targetFile: context.generatedTestFile }
      : results.some((item) => item.name === "playwright")
        ? { status: "executed" as const, reason: "Stored Playwright command executed." }
        : manifest.plan.playwright
          ? { status: "unavailable" as const, reason: "No resumable Playwright target or command was available." }
          : { status: "skipped" as const, reason: "Playwright execution was disabled." };
    const summary = await summarizeRun(
      context, collected.diff, project, results, collected.snapshots, manifest.config, baseline,
      coverage,
      stored.playwrightSource, findings, differential, overlay
    );
    await recordExistingArtifacts(state, context, findings);
    const otherFailure = Object.entries(state.manifest.phases)
      .some(([name, phase]) => name !== "execute" && phase.status === "failed");
    await finishRun(state, otherFailure ? "failed" : summary.status);
    output = summary;
  } catch (error) {
    failure = error;
    await recordExecuteError(state, error).catch(() => undefined);
    if (context) {
      try {
        const findings = await findingsArtifacts(root, state.manifest, context);
        await writePartialRunSummary(context, error, findings, overlay);
        await recordExistingArtifacts(state, context, findings);
      } catch (preserveError) {
        if (!failure) failure = preserveError;
      }
    }
    await failRun(state, "execute", message(error)).catch(() => undefined);
  } finally {
    try {
      await removeSandbox(workRoot);
    } catch (error) {
      if (!failure) {
        failure = error;
        await recordExecuteError(state, error).catch(() => undefined);
        if (context) {
          try {
            const findings = await findingsArtifacts(root, state.manifest, context);
            await writePartialRunSummary(context, error, findings, overlay);
            await recordExistingArtifacts(state, context, findings);
          } catch {
            // Preserve the cleanup error as the primary failure.
          }
        }
        await failRun(state, "execute", message(error)).catch(() => undefined);
      }
    }
  }
  if (failure) throw failure;
  return output!;
}

async function applyLocked(root: string, options: ApplyRunOptions) {
  const manifest = await loadRunManifest(root, options.runId);
  const stale = staleOperation(manifest, "apply", Boolean(options.force));
  await verifyArtifacts(root, manifest);
  if (!manifest.capabilities.apply) throw new ChangeForgeError("This run has no generated overlay to apply.", "RUN_NOT_APPLICABLE");
  const read = await readVerifiedArtifact(root, manifest, "overlay");
  const overlay = validateGeneratedOverlayV1(parseJson(read.bytes, "overlay"));
  const state: RunState = { root, manifest, active: null };
  if (stale) await recoverRunningPhase(state, "apply", "Recovered a stale apply attempt with --force.");
  if (manifest.phases.apply.status === "completed") {
    const stateNow = await generatedOverlayState(root, overlay);
    if (stateNow === "after") {
      if (state.manifest.status === "running") {
        await startPhase(state, "apply", true);
        try {
          await verifyApplySource(root, state.manifest, overlay);
          const terminal = await applyTerminalStatus(root, state.manifest);
          await completePhase(state, "apply");
          await finishRun(state, terminal);
          return { runId: manifest.runId, status: "already-applied" as const };
        } catch (error) {
          await failActivePhase(state, message(error)).catch(() => undefined);
          throw error;
        }
      }
      await verifyApplySource(root, state.manifest, overlay);
      return { runId: manifest.runId, status: "already-applied" as const };
    }
    if (!options.force) {
      throw new ChangeForgeError("The completed generated overlay is absent; repeat with --force.", "RUN_APPLY_FORCE_REQUIRED");
    }
  }
  await startPhase(state, "apply", Boolean(options.force));
  try {
    const stateNow = await generatedOverlayState(root, overlay);
    await verifyApplySource(root, state.manifest, overlay);
    const terminal = await applyTerminalStatus(root, state.manifest);
    if (stateNow === "after") {
      await completePhase(state, "apply");
      await finishRun(state, terminal);
      return { runId: manifest.runId, status: "already-applied" as const };
    }
    const status = await applyGeneratedOverlay(root, overlay);
    await completePhase(state, "apply");
    await finishRun(state, terminal);
    return { runId: manifest.runId, status };
  } catch (error) {
    await failActivePhase(state, message(error)).catch(() => undefined);
    throw error;
  }
}

async function applyTerminalStatus(root: string, manifest: RunManifestV1) {
  if (["passed", "partial"].includes(manifest.status)) return manifest.status as "passed" | "partial";
  if (Object.entries(manifest.phases).some(([name, phase]) => name !== "apply" && phase.status === "failed")) return "failed" as const;
  if (!manifest.artifacts.summary) return "partial" as const;
  const summary = parseJson<Record<string, unknown>>((await readVerifiedArtifact(root, manifest, "summary")).bytes, "summary");
  return summary.status === "passed" ? "passed" as const : "partial" as const;
}

async function verifyApplySource(root: string, manifest: RunManifestV1, overlay: GeneratedOverlayV1) {
  if (["commit", "range"].includes(manifest.input.kind)) {
    const result = await execa("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, env: isolatedGitEnv() });
    if (result.stdout.trim() !== manifest.resolved.headSha) {
      throw new ChangeForgeError("The checkout HEAD no longer matches the inspected change.", "RUN_SOURCE_CHANGED");
    }
    return;
  }
  const stored = validateChangeSnapshotV1(parseJson(
    (await readVerifiedArtifact(root, manifest, "snapshot")).bytes,
    "snapshot"
  ));
  const current = snapshotChangeSet(await resolveChangeSet(root, manifest.input));
  const generated = new Set(overlay.entries.map((entry) => entry.path));
  const normalized = current.overlay.filter((entry) => !generated.has(entry.path));
  for (const entry of stored.overlay) if (generated.has(entry.path)) normalized.push(entry);
  normalized.sort((left, right) => left.path === right.path ? 0 : left.path < right.path ? -1 : 1);
  const source = ({ input, baseSha, headSha, symlinks, overlay: entries }: ChangeSnapshotV1) => ({
    input, baseSha, headSha, symlinks, overlay: entries
  });
  if (JSON.stringify({ ...source(current), overlay: normalized }) !== JSON.stringify(source(stored))) {
    throw new ChangeForgeError("The working change no longer matches the inspected snapshot.", "RUN_SOURCE_CHANGED");
  }
}

async function resumeContext(
  root: string,
  workRoot: string,
  manifest: RunManifestV1,
  change: ResolvedChangeSet,
  generated: boolean
): Promise<RunContext> {
  const config = manifest.config;
  const e2eTestFile = optionalRunPath(workRoot, config.playwright.e2eTestPath, manifest.runId);
  const e2eTestFileExists = Boolean(e2eTestFile && await existsContained(workRoot, e2eTestFile));
  const fallback = makeTestsDir(workRoot, config.testsDir, manifest.runId);
  const testsDir = e2eTestFileExists
    ? path.join(path.dirname(e2eTestFile!), `changeforge-${manifest.runId}`)
    : fallback;
  const generatedTestFile = e2eTestFileExists
    ? path.join(testsDir, path.basename(e2eTestFile!))
    : path.join(testsDir, "test-edge-cases.spec.ts");
  return {
    runId: manifest.runId,
    originalRoot: root,
    workRoot,
    runDir: makeRunDir(root, manifest.runId),
    reportDir: makeReportDir(root, config.docsDir, manifest.runId),
    testsDir,
    generatedTestFile,
    e2eTestFile,
    e2eTestFileExists,
    testFocus: config.playwright.testFocus,
    input: manifest.input,
    baseSha: change.baseSha,
    headSha: change.headSha,
    generate: generated,
    execute: true,
    allowSourceEdits: false
  };
}

async function runStoredPlan(
  context: RunContext,
  project: ProjectDetection,
  manifest: RunManifestV1,
  generatedPlaywright: boolean,
  verify: () => Promise<void>
): Promise<{ results: TestResult[]; playwrightSource: string | null }> {
  const plan = manifest.plan;
  const options = {
    execute: true,
    unitCommand: plan.unitCommand ?? undefined,
    playwrightCommand: plan.playwrightCommand ?? undefined,
    generatedPlaywright
  };
  const guarded = async (selected: Parameters<typeof runTests>[3]) => {
    await verify();
    const results = await runTests(context, project, manifest.config, selected);
    await verify();
    return results;
  };
  const unit = plan.unit ? await guarded({ ...options, unit: true, playwright: false }) : [];
  const canRunPlaywright = plan.playwright && (
    context.e2eTestFileExists || generatedPlaywright || Boolean(plan.playwrightCommand)
  );
  const playwright = canRunPlaywright
    ? await guarded({ ...options, unit: false, playwright: true })
    : [];
  const results = [...unit, ...playwright];
  const playwrightSource = playwright.some((item) => item.name === "playwright")
    ? runtimePlaywrightReportDir(context)
    : null;
  return { results, playwrightSource };
}

async function findingsArtifacts(root: string, manifest: RunManifestV1, context: RunContext) {
  if (!manifest.artifacts.findings) return undefined;
  const document = validateFindings(parseJson<FindingsDocumentV1>((await readVerifiedArtifact(root, manifest, "findings")).bytes, "findings"));
  return { document, artifact: path.join(context.runDir, manifest.artifacts.findings.path), report: path.join(context.reportDir, "code-review.md") };
}

async function recordExecuteError(state: RunState, error: unknown) {
  const file = path.join(makeRunDir(state.root, state.manifest.runId), "artifacts/execute-error.v1.json");
  await writeJsonContained(state.root, file, {
    schemaVersion: "1.0",
    runId: state.manifest.runId,
    phase: "execute",
    attempt: state.manifest.phases.execute.attempts,
    createdAt: new Date().toISOString(),
    error: {
      code: error instanceof ChangeForgeError ? error.code : "EXECUTE_FAILED",
      message: message(error)
    }
  });
  await recordRunArtifact(state, "executeError", file);
}

function staleOperation(manifest: RunManifestV1, operation: "execute" | "apply", force: boolean) {
  const running = Object.entries(manifest.phases).find(([, phase]) => phase.status === "running")?.[0];
  if (!running && manifest.status !== "running") return false;
  if (!force) throw new ChangeForgeError("The run is still in progress.", "RUN_IN_PROGRESS");
  const allowed = operation === "execute" ? ["execute", "differential"] : ["apply"];
  if (running && !allowed.includes(running)) {
    throw new ChangeForgeError(`Cannot recover ${operation}; ${running} did not complete.`, "RUN_NOT_RESUMABLE");
  }
  return running && allowed.includes(running) ? running as "execute" | "differential" | "apply" : null;
}

function assertExecuteEligibility(manifest: RunManifestV1) {
  const { resolve, review, generate } = manifest.phases;
  if (resolve.status !== "completed" || review.status !== "completed" || !["completed", "skipped"].includes(generate.status)) {
    throw new ChangeForgeError("Execution requires completed resolve and review phases and a completed or skipped generation phase.", "RUN_NOT_RESUMABLE");
  }
}

function validateFindings(value: FindingsDocumentV1) {
  if (!value || value.schemaVersion !== "1.0" || !Array.isArray(value.findings)) integrity("Findings artifact is invalid.");
  const severities = new Set(["low", "medium", "high", "critical"]);
  for (const finding of value.findings) {
    if (!finding || typeof finding.id !== "string" || !severities.has(finding.severity)) integrity("Findings artifact is invalid.");
  }
  return value;
}

function validateSummary(value: unknown, manifest: RunManifestV1) {
  if (!value || typeof value !== "object" || Array.isArray(value)) integrity("Summary artifact is invalid.");
  const summary = value as Record<string, unknown>;
  if (summary.runId !== manifest.runId || !["passed", "partial", "failed"].includes(String(summary.status))) {
    integrity("Summary artifact is invalid.");
  }
  return summary;
}

function validateExecuteError(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) integrity("Execute-error artifact is invalid.");
  const error = value as Record<string, unknown>;
  if (error.schemaVersion !== "1.0" || error.phase !== "execute" || !error.error || typeof error.error !== "object") {
    integrity("Execute-error artifact is invalid.");
  }
  return error;
}

async function validateStoredArtifacts(root: string, manifest: RunManifestV1) {
  await verifyArtifacts(root, manifest);
  const read = async (name: string) => parseJson((await readVerifiedArtifact(root, manifest, name)).bytes, name);
  if (!manifest.artifacts.snapshot) integrity("Snapshot artifact is missing.");
  if (manifest.artifacts.snapshot.sha256 !== manifest.resolved.changeSha256) integrity("Snapshot digest does not match the resolved change.");
  validateChangeSnapshotV1(await read("snapshot"));
  if (manifest.artifacts.findings) validateFindings(await read("findings") as FindingsDocumentV1);
  const overlay = manifest.artifacts.overlay ? validateGeneratedOverlayV1(await read("overlay")) : null;
  if (manifest.phases.differential.status === "completed" && !manifest.artifacts.differential) {
    integrity("Completed differential evidence is missing.");
  }
  const differential = manifest.artifacts.differential
    ? validateDifferentialBinding(await read("differential"), overlay)
    : null;
  if (manifest.plan.differential && manifest.phases.differential.status === "completed" && !differential) {
    integrity("Completed differential evidence is missing.");
  }
  const summary = manifest.artifacts.summary ? validateSummary(await read("summary"), manifest) : null;
  if (differential) validateDifferentialState(manifest, summary, differential);
  if (manifest.artifacts.generatedFiles) {
    const generated = await read("generatedFiles");
    if (!Array.isArray(generated) || generated.some((item) => typeof item !== "string")) integrity("Generated-files artifact is invalid.");
  }
  if (manifest.artifacts.executeError) validateExecuteError(await read("executeError"));
}

async function resumeDifferentialPhase(
  state: RunState,
  context: RunContext,
  change: ResolvedChangeSet,
  project: ProjectDetection,
  overlay: GeneratedOverlayV1 | null,
  options: ExecuteRunOptions,
  headOutputRoots: string[]
): Promise<DifferentialArtifactV1 | null> {
  if (!state.manifest.plan.differential) return null;
  if (state.manifest.phases.differential.status === "completed" && !options.force) {
    if (!overlay || !state.manifest.artifacts.differential) {
      throw new ChangeForgeError("Completed differential evidence is missing.", "RUN_ARTIFACT_INVALID");
    }
    return validateDifferentialBinding(
      parseJson((await readVerifiedArtifact(state.root, state.manifest, "differential")).bytes, "differential"),
      overlay
    );
  }
  await startPhase(state, "differential", Boolean(options.force));
  if (!overlay?.entries.length) {
    throw new ChangeForgeError("Differential verification requires generated sidecar evidence.", "DIFFERENTIAL_OVERLAY_REQUIRED");
  }
  const artifact = await runDifferentialWorkflow({
    context,
    change,
    project,
    config: state.manifest.config,
    overlay,
    installDeps: Boolean(options.installDeps),
    setupCommand: state.manifest.plan.setupCommand,
    headOutputRoots,
    playwrightCommand: state.manifest.plan.playwrightCommand,
    attempt: state.manifest.phases.differential.attempts
  });
  const file = path.join(context.runDir, "artifacts/differential.v1.json");
  await writeJsonContained(context.originalRoot, file, artifact);
  await recordRunArtifact(state, "differential", file);
  if (["invalid", "regression-detected"].includes(artifact.result.classification)) {
    await failActivePhase(state, artifact.result.reason);
  } else await completePhase(state, "differential");
  return artifact;
}

function integrityError(artifact: string, error: unknown) {
  return {
    artifact,
    code: error instanceof ChangeForgeError ? error.code : "RUN_ARTIFACT_INVALID",
    message: message(error)
  };
}

function validateDifferentialState(
  manifest: RunManifestV1,
  summary: Record<string, unknown> | null,
  artifact: DifferentialArtifactV1
) {
  const failed = ["invalid", "regression-detected"].includes(artifact.result.classification);
  const phase = manifest.phases.differential.status;
  if (phase !== (failed ? "failed" : "completed") || failed && manifest.status !== "failed") {
    integrity("Differential artifact contradicts the run phase or status.");
  }
  if (!summary) return;
  const differential = summary.differential;
  if (!differential || typeof differential !== "object" || Array.isArray(differential)
    || (differential as Record<string, unknown>).classification !== artifact.result.classification) {
    integrity("Summary does not match differential evidence.");
  }
  if (artifact.result.classification === "no-discrimination" && !["partial", "failed"].includes(String(summary.status))) {
    integrity("Non-discriminating evidence cannot have a passing summary.");
  }
  if (failed && summary.status !== "failed") {
    integrity("Failed differential evidence requires a failed summary.");
  }
}

function parseJson<T = unknown>(bytes: Buffer, name: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new ChangeForgeError(`Run artifact ${name} is not valid JSON.`, "RUN_ARTIFACT_INVALID");
  }
}

function integrity(messageText: string): never {
  throw new ChangeForgeError(messageText, "RUN_ARTIFACT_INVALID");
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function terminalText(value: string) {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1).replace(/[\u007f-\u009f]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
