export { buildProgram } from "./cli.js";
export { runPipeline } from "./pipeline/run.js";
export type { RunOptions, RunSummary } from "./pipeline/run.js";
export { applyRun, executeRun, inspectRun } from "./pipeline/resume.js";
export type { ApplyRunOptions, ExecuteRunOptions, InspectRunOptions } from "./pipeline/resume.js";
export type { RunStatus } from "./pipeline/summarize.js";
export {
  FINDINGS_SCHEMA_VERSION, MAX_FINDINGS, MAX_REVIEW_OUTPUT_BYTES, parseFindingsV1, renderFindingsMarkdown
} from "./core/findings.js";
export type { FindingsArtifactsV1, FindingsDocumentV1, FindingSeverity, FindingV1 } from "./core/findings.js";
export type {
  RunArtifactV1, RunCapabilitiesV1, RunManifestV1, RunPhase, RunPhaseState, RunPlanV1
} from "./core/run-manifest.js";
export {
  createRunManifestV1, RUN_MANIFEST_FILE, RUN_MANIFEST_SCHEMA_VERSION, RUN_PHASES, setPhase,
  validateRunManifestV1
} from "./core/run-manifest.js";
export { stageImmutableArtifact } from "./core/immutable-artifact.js";
export { cleanRuns, pruneRuns } from "./core/run-cleanup.js";
export type { CleanRunsOptions, CleanRunsResult } from "./core/run-cleanup.js";
export type { ChangeSnapshotV1 } from "./git/change-set.js";
export type { GeneratedOverlayV1 } from "./git/generated-overlay.js";
export {
  CHANGE_SNAPSHOT_SCHEMA_VERSION, restoreChangeSet, snapshotChangeSet, validateChangeSnapshotV1
} from "./git/change-set.js";
export {
  applyGeneratedOverlay, captureGeneratedOverlay, GENERATED_OVERLAY_SCHEMA_VERSION,
  generatedOverlayState, replayGeneratedOverlay, validateGeneratedOverlayV1
} from "./git/generated-overlay.js";
export {
  buildDifferentialResult, classifyDifferential, DIFFERENTIAL_SCHEMA_VERSION, parsePlaywrightJsonSide
} from "./pipeline/differential.js";
export type {
  DifferentialClassification, DifferentialCommandResult, DifferentialOutcome,
  DifferentialResultV1, DifferentialSideV1
} from "./pipeline/differential.js";
export {
  DIFFERENTIAL_EXECUTION_SCHEMA_VERSION, differentialPlaywrightSpec, runDifferentialVerification
} from "./pipeline/differential-runner.js";
export type {
  DifferentialExecutionV1, DifferentialRunnerOptions
} from "./pipeline/differential-runner.js";
export { validateDifferentialArtifactV1 } from "./pipeline/differential-workflow.js";
export type { DifferentialArtifactV1 } from "./pipeline/differential-workflow.js";
