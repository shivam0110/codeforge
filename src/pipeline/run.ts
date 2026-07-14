import path from "node:path";
import { loadConfig } from "../core/config.js";
import { ChangeForgeError } from "../core/errors.js";
import type { FindingsArtifactsV1 } from "../core/findings.js";
import { pruneRuns } from "../core/run-cleanup.js";
import { withRunLock } from "../core/run-store.js";
import {
  buildRunId, optionalRunPath, reportDir as makeReportDir,
  runDir as makeRunDir, testsDir as makeTestsDir
} from "../core/paths.js";
import type { ChangeForgeConfig, ProjectDetection, RunContext } from "../core/types.js";
import { materializeChangeSet, resolveChangeSet, type ResolvedChangeSet } from "../git/change-set.js";
import type { GeneratedOverlayV1 } from "../git/generated-overlay.js";
import { inputFromOptions } from "../git/diff.js";
import { createPatchBaseline, saveChangedFiles, savePatch, type PatchBaseline } from "../git/patch.js";
import { repoRoot } from "../git/repo.js";
import { removeSandbox, sandboxPath } from "../git/sandbox.js";
import { detectProject } from "../project/detect.js";
import { linkLocalDependencies } from "../project/dependencies.js";
import { installDevSpec } from "../project/package-manager.js";
import { installDevDeps } from "../runners/npm.js";
import { runSetupCommand } from "../runners/setup.js";
import { existsContained, writeJsonContained } from "../utils/fs.js";
import { collectContext, type CollectedContext } from "./collect-context.js";
import type { DifferentialArtifactV1 } from "./differential-workflow.js";
import { runDifferentialWorkflow } from "./differential-workflow.js";
import { createInputIntegrityGuard } from "./input-integrity.js";
import { generatePlaywrightCoverage, type PlaywrightGenerationResult } from "./playwright.js";
import { reviewChange } from "./review.js";
import { runTests, runtimePlaywrightReportDir, type TestOptions, type TestResult } from "./run-tests.js";
import {
  completePhase, createRunState, failActivePhase, failRun, finishRun, persistGeneratedOverlay,
  recordExistingArtifacts, recordRunArtifact, skipPhase, startPhase, verifyGeneratedOverlay,
  type RunState
} from "./run-state.js";
import { summarizeRun, writePartialRunSummary, type RunStatus } from "./summarize.js";

export type RunOptions = Omit<TestOptions, "generatedPlaywright"> & {
  repo?: string;
  range?: string;
  commit?: string;
  file?: string;
  workingTree?: boolean;
  generate?: boolean;
  keepSandbox?: boolean;
  installDeps?: boolean;
  setupCommand?: string;
  allowSourceEdits?: boolean;
  model?: string;
  differential?: boolean;
};

export type RunSummary = Omit<Awaited<ReturnType<typeof summarizeRun>>, "status"> & { status: RunStatus };

type PreparedRun = {
  config: ChangeForgeConfig;
  context: RunContext;
  change: ResolvedChangeSet;
  baseline: PatchBaseline;
};

export async function runPipeline(options: RunOptions): Promise<RunSummary> {
  const prepared = await prepareRun(options);
  let entered = false;
  try {
    return await withRunLock(prepared.context.originalRoot, prepared.context.runId, "run", async () => {
      entered = true;
      return runPreparedPipeline(options, prepared);
    });
  } catch (error) {
    if (!entered) await removeSandbox(prepared.context.workRoot).catch(() => undefined);
    throw error;
  } finally {
    await pruneRuns(prepared.context.originalRoot).catch((error) => {
      log(`run cleanup warning: ${message(error).split("\n", 1)[0]}`);
    });
  }
}

async function runPreparedPipeline(options: RunOptions, prepared: PreparedRun): Promise<RunSummary> {
  const context: RunContext = prepared.context;
  let failure: unknown;
  let failurePatchSaved = false;
  let findings: FindingsArtifactsV1 | undefined;
  let frozenOverlay: GeneratedOverlayV1 | null = null;
  let differential: DifferentialArtifactV1 | null = null;
  let summary: Awaited<ReturnType<typeof summarizeRun>> | undefined;
  let state: RunState | undefined;
  try {
    state = await createRunState(context, prepared.change, prepared.config, options);
    await startPhase(state, "review");
    const project = await detectProject(context.workRoot);
    if (options.differential && !project.hasPlaywright) {
      throw new ChangeForgeError(
        "Differential verification requires @playwright/test; add it or use --execute --install-deps.",
        "DIFFERENTIAL_PLAYWRIGHT_REQUIRED"
      );
    }
    const collected = await collectAndPersistContext(context, prepared.change, project);
    const review = await reviewWithCodex(context, collected, prepared.config, options);
    findings = review.findings;
    await recordRunArtifact(state, "findings", findings.artifact);
    await completePhase(state, "review");
    if (context.generate) await startPhase(state, "generate");
    else await skipPhase(state, "generate", "Generation was not authorized.");
    const coverage = await generatePlaywrightCoverage(context, collected, review.findings.report, prepared.config, {
      generate: context.generate,
      playwright: options.playwright,
      model: options.model
    });
    if (coverage.status === "generated") {
      log(`generated test ${path.join(context.reportDir, path.basename(coverage.targetFile))}`);
    }
    const executionProject = await prepareExecutionDependencies(
      context, collected.project, prepared.config, options, coverage
    );
    const inputs = createInputIntegrityGuard(context.workRoot, () => prepared.baseline.ignored);
    const onGeneratedChange = async () => {
      frozenOverlay = await persistGeneratedOverlay(state!, context, prepared.baseline);
      if (context.execute) await inputs.refresh();
    };
    const verifyGenerated = async () => {
      if (frozenOverlay) await verifyGeneratedOverlay(context.workRoot, frozenOverlay);
      if (context.execute) await inputs.verify();
    };
    if (coverage.status === "generated") await onGeneratedChange();
    else if (context.execute) await inputs.refresh();
    if (context.execute) prepared.baseline.ignored.push(...inputs.outputRoots());
    if (context.generate) await completePhase(state, "generate");
    if (context.execute) await startPhase(state, "execute");
    else await skipPhase(state, "execute", "Execution was not authorized.");
    const setupCommand = options.setupCommand ?? prepared.config.setupCommand;
    if (context.execute && setupCommand) {
      await verifyGenerated();
      log("running trusted setup command");
      await runSetupCommand(
        context.workRoot,
        setupCommand,
        path.join(context.runDir, "logs/setup.log"),
        context.originalRoot,
        prepared.config.commandTimeoutMs
      );
      await verifyGenerated();
    }
    const results = await executePhases(
      context, executionProject, prepared.config, options, coverage, { verify: verifyGenerated }
    );
    const finalCoverage: PlaywrightGenerationResult = results.some((item) => item.name === "playwright") && coverage.status !== "generated"
      ? { status: "executed", reason: "An existing or custom Playwright command executed." }
      : coverage;
    const playwrightSource = results.some((item) => item.name === "playwright")
      ? runtimePlaywrightReportDir(context)
      : null;
    if (context.execute) {
      if (latestCommandsFailed(results)) await failActivePhase(state, "One or more commands failed.");
      else await completePhase(state, "execute");
    }
    differential = await differentialPhase(
      state, context, prepared.change, executionProject, prepared.config, options, frozenOverlay, inputs.outputRoots()
    );
    summary = await summarizeRun(
      context, collected.diff, executionProject, results, collected.snapshots,
      prepared.config, prepared.baseline, finalCoverage, playwrightSource, findings, differential, frozenOverlay
    );
    await recordExistingArtifacts(state, context, findings);
    await finishRun(state, summary.status);
    console.log(JSON.stringify({ runId: context.runId, status: summary.status, report: context.reportDir }, null, 2));
  } catch (error) {
    failure = error;
    log(`${state?.active ?? "run"} failed: ${message(error).split("\n", 1)[0]}`);
    try {
      await saveFailurePatch(context, prepared.baseline);
      failurePatchSaved = true;
    } catch (patchError) {
      log(`failed to preserve failure patch: ${message(patchError)}`);
    }
    try {
      await writePartialRunSummary(context, error, findings, frozenOverlay);
    } catch (summaryError) {
      log(`failed to write partial summary: ${message(summaryError)}`);
    }
    if (state) {
      try {
        await recordExistingArtifacts(state, context, findings);
        await failRun(state, context.execute ? "execute" : context.generate ? "generate" : "review", message(error));
      } catch (stateError) {
        log(`failed to preserve run manifest: ${message(stateError)}`);
      }
    }
  } finally {
    try {
      const retainFailedEdits = Boolean(failure && context.allowSourceEdits && !failurePatchSaved);
      if (retainFailedEdits) log(`retaining failed sandbox ${context.workRoot}`);
      await cleanupSandbox(context, Boolean(options.keepSandbox) || retainFailedEdits);
    } catch (error) {
      if (!failure) {
        failure = error;
        if (state) {
          try {
            await writePartialRunSummary(context, error, findings, frozenOverlay);
            await recordExistingArtifacts(state, context, findings);
            await failRun(state, context.execute ? "execute" : context.generate ? "generate" : "review", message(error));
          } catch (stateError) {
            log(`failed to preserve cleanup failure: ${message(stateError)}`);
          }
        }
      } else log(`failed to remove sandbox: ${message(error)}`);
    }
  }
  if (failure) throw failure;
  return summary!;
}

async function saveFailurePatch(context: RunContext, baseline: PatchBaseline) {
  const artifacts = path.join(context.runDir, "artifacts");
  await savePatch(context.workRoot, baseline, path.join(artifacts, "patch.diff"));
  await saveChangedFiles(context.workRoot, baseline, path.join(artifacts, "generated-files.json"));
}

async function prepareRun(options: RunOptions): Promise<PreparedRun> {
  log("resolving immutable change set");
  const originalRoot = await repoRoot(options.repo ?? process.cwd());
  const config = await loadConfig(originalRoot);
  const input = inputFromOptions(options);
  const change = await resolveChangeSet(originalRoot, input);
  const runId = buildRunId(input);
  const workRoot = await sandboxPath(originalRoot);
  try {
    return await prepareSandbox(options, config, change, input, originalRoot, workRoot, runId);
  } catch (error) {
    await removeSandbox(workRoot).catch(() => undefined);
    throw error;
  }
}

async function prepareSandbox(
  options: RunOptions,
  config: ChangeForgeConfig,
  change: ResolvedChangeSet,
  input: RunContext["input"],
  originalRoot: string,
  workRoot: string,
  runId: string
): Promise<PreparedRun> {
  await materializeChangeSet(change, workRoot);
  const runDir = makeRunDir(originalRoot, runId);
  const e2eTestFile = optionalRunPath(workRoot, config.playwright.e2eTestPath, runId);
  const e2eTestFileExists = Boolean(e2eTestFile && await existsContained(workRoot, e2eTestFile));
  const fallbackTestsDir = makeTestsDir(workRoot, config.testsDir, runId);
  const testsDir = e2eTestFileExists
    ? path.join(path.dirname(e2eTestFile!), `changeforge-${runId}`)
    : fallbackTestsDir;
  const generatedTestFile = e2eTestFileExists
    ? path.join(testsDir, path.basename(e2eTestFile!))
    : path.join(testsDir, "test-edge-cases.spec.ts");
  const generate = Boolean(options.generate);
  const execute = Boolean(options.execute);
  const allowSourceEdits = Boolean(options.allowSourceEdits ?? config.allowSourceEdits);
  if (generate && allowSourceEdits) {
    throw new ChangeForgeError(
      "Strict sidecar generation does not permit source edits; disable allowSourceEdits.",
      "OPTION_UNSUPPORTED"
    );
  }
  if (options.installDeps && !execute) {
    throw new ChangeForgeError("Dependency installation requires --execute.", "EXECUTION_CONSENT_REQUIRED");
  }
  if (options.setupCommand && !execute) {
    throw new ChangeForgeError("Setup command requires --execute.", "EXECUTION_CONSENT_REQUIRED");
  }
  if (options.differential && !generate) {
    throw new ChangeForgeError("Differential verification requires --generate.", "DIFFERENTIAL_GENERATION_REQUIRED");
  }
  if (options.differential && (options.playwright === false || !config.playwright.enabled)) {
    throw new ChangeForgeError("Differential verification requires Playwright generation.", "DIFFERENTIAL_PLAYWRIGHT_REQUIRED");
  }
  if (options.differential && (options.playwrightCommand ?? config.playwrightCommand)) {
    throw new ChangeForgeError(
      "Differential verification requires the direct Playwright command; custom commands are unsupported.",
      "DIFFERENTIAL_CUSTOM_COMMAND_UNSUPPORTED"
    );
  }
  if (options.differential && (!config.webServer.command || !config.webServer.url)) {
    throw new ChangeForgeError(
      "Differential verification requires configured webServer.command and webServer.url.",
      "DIFFERENTIAL_RUNTIME_CONFIG_REQUIRED"
    );
  }
  const context: RunContext = {
    runId,
    originalRoot,
    workRoot,
    runDir,
    reportDir: makeReportDir(originalRoot, config.docsDir, runId),
    testsDir,
    generatedTestFile,
    e2eTestFile,
    e2eTestFileExists,
    testFocus: config.playwright.testFocus,
    input,
    baseSha: change.baseSha,
    headSha: change.headSha,
    generate,
    execute,
    allowSourceEdits
  };
  const baseline = await createPatchBaseline(workRoot, runDir, originalRoot);
  log(`run ${runId}`);
  log(`sandbox ${workRoot}`);
  return { config, context, change, baseline };
}

async function prepareExecutionDependencies(
  context: RunContext,
  project: ProjectDetection,
  config: ChangeForgeConfig,
  options: RunOptions,
  coverage: PlaywrightGenerationResult
) {
  if (!context.execute) return project;
  if (options.installDeps && (!project.hasPackageJson || !project.packageManager)) {
    throw new ChangeForgeError("Dependency installation requires a package.json and supported package manager.", "PACKAGE_MANAGER_MISSING");
  }
  if (options.installDeps && project.packageManager) {
    log("installing dependencies with lifecycle scripts disabled");
    await installDevDeps(context.workRoot, project.packageManager, project.missingRecommendedDeps, config.commandTimeoutMs);
    return detectProject(context.workRoot);
  }
  const setup = options.setupCommand ?? config.setupCommand;
  if (project.packageManager) {
    const local = await existsContained(context.originalRoot, path.join(context.originalRoot, "node_modules"));
    const directPlaywright = options.playwright !== false && config.playwright.enabled
      && project.hasPlaywright && !(options.playwrightCommand ?? config.playwrightCommand)
      && (context.e2eTestFileExists || coverage.status === "generated");
    if (local || setup || directPlaywright || options.differential) {
      log("reusing local dependencies");
      await linkLocalDependencies(context.originalRoot, context.workRoot, project.packageManager);
    }
  }
  if (project.packageManager && project.missingRecommendedDeps.length) {
    console.log(`Missing recommended dependencies:\n  ${project.missingRecommendedDeps.join("\n  ")}\n\nInstall explicitly with --execute --install-deps (${installDevSpec(project.packageManager, project.missingRecommendedDeps).display}).`);
  }
  return project;
}

async function collectAndPersistContext(context: RunContext, change: ResolvedChangeSet, project: ProjectDetection) {
  log("collecting file and project context from the sandbox");
  const collected = await collectContext(context, change, project);
  await writeJsonContained(context.originalRoot, path.join(context.runDir, "context/run-context.json"), context);
  return collected;
}

async function reviewWithCodex(
  context: RunContext,
  collected: CollectedContext,
  config: ChangeForgeConfig,
  options: RunOptions
) {
  log("reviewing a disposable immutable sandbox with Codex (read-only)");
  return reviewChange(context, collected, options.model, config.codex);
}

async function executePhases(
  context: RunContext,
  project: ProjectDetection,
  config: ChangeForgeConfig,
  options: RunOptions,
  coverage: PlaywrightGenerationResult,
  evidence: { verify(): Promise<void> }
) {
  if (!context.execute) return [];
  const executionOptions: TestOptions = { ...options, generatedPlaywright: coverage.status === "generated" };
  const guardedRun = async (selected: TestOptions) => {
    await evidence.verify();
    const results = await runTests(context, project, config, selected);
    await evidence.verify();
    return results;
  };
  const unit = await guardedRun({ ...executionOptions, execute: true, playwright: false });
  const canRunPlaywright = options.playwright !== false && (
    context.e2eTestFileExists || coverage.status === "generated" || Boolean(options.playwrightCommand ?? config.playwrightCommand)
  );
  const playwright = canRunPlaywright
    ? await guardedRun({ ...executionOptions, execute: true, unit: false })
    : [];
  return [...unit, ...playwright];
}

async function cleanupSandbox(context: RunContext | null, keep: boolean) {
  if (!context || keep) return;
  await removeSandbox(context.workRoot);
}

function log(value: string) {
  console.log(`ChangeForge: ${value}`);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function latestCommandsFailed(results: TestResult[]) {
  const latest = new Map<string, number>();
  for (const item of results) latest.set(item.name, item.result.exitCode);
  return [...latest.values()].some((exitCode) => exitCode !== 0);
}

async function differentialPhase(
  state: RunState,
  context: RunContext,
  change: ResolvedChangeSet,
  project: ProjectDetection,
  config: ChangeForgeConfig,
  options: RunOptions,
  overlay: GeneratedOverlayV1 | null,
  headOutputRoots: string[]
) {
  if (!options.differential) {
    await skipPhase(state, "differential", "Differential verification was not requested.");
    return null;
  }
  if (!context.execute) {
    await skipPhase(state, "differential", "Execution was not authorized; resume with execute --run.");
    return null;
  }
  await startPhase(state, "differential");
  if (!overlay?.entries.length) {
    throw new ChangeForgeError("Differential verification requires generated sidecar evidence.", "DIFFERENTIAL_OVERLAY_REQUIRED");
  }
  const artifact = await runDifferentialWorkflow({
    context,
    change,
    project,
    config,
    overlay,
    installDeps: Boolean(options.installDeps),
    setupCommand: options.setupCommand ?? config.setupCommand,
    headOutputRoots,
    playwrightCommand: options.playwrightCommand ?? config.playwrightCommand,
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
