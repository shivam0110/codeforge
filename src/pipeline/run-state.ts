import { createHash } from "node:crypto";
import path from "node:path";
import { ChangeForgeError } from "../core/errors.js";
import type { FindingsArtifactsV1 } from "../core/findings.js";
import { stageImmutableArtifact } from "../core/immutable-artifact.js";
import {
  createRunManifestV1,
  setPhase,
  validateRunManifestV1,
  type RunCapabilitiesV1,
  type RunManifestStatus,
  type RunManifestV1,
  type RunPhase,
  type RunPlanV1
} from "../core/run-manifest.js";
import { saveRunManifest, updateRunManifest } from "../core/run-store.js";
import type { ChangeForgeConfig, RunContext } from "../core/types.js";
import { snapshotChangeSet, type ResolvedChangeSet } from "../git/change-set.js";
import {
  captureGeneratedOverlay, generatedOverlayState, type GeneratedOverlayV1
} from "../git/generated-overlay.js";
import type { PatchBaseline } from "../git/patch.js";
import { existsContained, readBufferContained, writeJsonContained } from "../utils/fs.js";
import type { RunOptions } from "./run.js";

export const RUN_ARTIFACTS = {
  snapshot: "artifacts/change-snapshot.v1.json",
  overlay: "artifacts/generated-overlay.v1.json",
  findings: "artifacts/findings.v1.json",
  summary: "artifacts/summary.json",
  patch: "artifacts/patch.diff",
  generatedFiles: "artifacts/generated-files.json",
  differential: "artifacts/differential.v1.json"
} as const;

export type RunState = { root: string; manifest: RunManifestV1; active: RunPhase | null };

export async function createRunState(
  context: RunContext,
  change: ResolvedChangeSet,
  config: ChangeForgeConfig,
  options: RunOptions
) {
  const snapshot = path.join(context.runDir, RUN_ARTIFACTS.snapshot);
  await writeJsonContained(context.originalRoot, snapshot, snapshotChangeSet(change));
  const digest = hash(await readBufferContained(context.originalRoot, snapshot));
  const plan = runPlan(config, options);
  const capabilities: RunCapabilitiesV1 = {
    generate: context.generate,
    execute: context.execute,
    installDependencies: Boolean(options.installDeps),
    differential: Boolean(options.differential),
    apply: false
  };
  const state: RunState = {
    root: context.originalRoot,
    manifest: createRunManifestV1({
      runId: context.runId,
      input: context.input,
      resolved: { baseSha: context.baseSha, headSha: context.headSha, changeSha256: digest },
      config,
      plan,
      capabilities
    }),
    active: null
  };
  state.manifest = await saveRunManifest(state.root, state.manifest);
  await startPhase(state, "resolve");
  await recordRunArtifact(state, "snapshot", snapshot);
  await completePhase(state, "resolve");
  return state;
}

export async function startPhase(state: RunState, phase: RunPhase, force = false) {
  await persist(state, setPhase(state.manifest, phase, "running", { force }), phase);
}

export async function completePhase(state: RunState, phase: RunPhase) {
  await persist(state, setPhase(state.manifest, phase, "completed"), null);
}

export async function skipPhase(state: RunState, phase: RunPhase, reason: string) {
  await persist(state, setPhase(state.manifest, phase, "skipped", { reason }), null);
}

export async function failActivePhase(state: RunState, reason: string) {
  if (!state.active || state.manifest.phases[state.active].status !== "running") return;
  await persist(state, setPhase(state.manifest, state.active, "failed", { reason }), null);
}

export async function recoverRunningPhase(state: RunState, phase: RunPhase, reason: string) {
  if (state.manifest.phases[phase].status !== "running") return;
  await persist(state, setPhase(state.manifest, phase, "failed", { reason }), null);
}

export async function failRun(state: RunState, phase: RunPhase, reason: string) {
  if (state.active) return failActivePhase(state, reason);
  if (Object.values(state.manifest.phases).some((item) => item.status === "failed")) return;
  const current = state.manifest.phases[phase].status;
  await startPhase(state, phase, current === "completed");
  await failActivePhase(state, reason);
}

export async function recordRunArtifact(state: RunState, name: string, file: string) {
  await persist(
    state,
    await stageImmutableArtifact(state.root, state.manifest, name, file),
    state.active
  );
}

export async function recordExistingArtifacts(state: RunState, context: RunContext, findings?: FindingsArtifactsV1) {
  const files: [string, string | undefined][] = [
    ["findings", findings?.artifact],
    ["summary", path.join(context.runDir, RUN_ARTIFACTS.summary)],
    ["patch", path.join(context.runDir, RUN_ARTIFACTS.patch)],
    ["generatedFiles", path.join(context.runDir, RUN_ARTIFACTS.generatedFiles)]
  ];
  for (const [name, file] of files) {
    if (file && await existsContained(context.originalRoot, file)) await recordRunArtifact(state, name, file);
  }
}

export async function persistGeneratedOverlay(state: RunState, context: RunContext, baseline: PatchBaseline) {
  const relative = path.relative(context.workRoot, context.generatedTestFile).split(path.sep).join("/");
  const overlay = await captureGeneratedOverlay(context.workRoot, baseline, [relative]);
  const file = path.join(context.runDir, RUN_ARTIFACTS.overlay);
  await writeJsonContained(context.originalRoot, file, overlay);
  await recordRunArtifact(state, "overlay", file);
  await grant(state, { apply: overlay.entries.length > 0 || state.manifest.phases.apply.status === "completed" });
  return overlay;
}

export async function verifyGeneratedOverlay(root: string, overlay: GeneratedOverlayV1) {
  if (await generatedOverlayState(root, overlay) !== "after") {
    throw new ChangeForgeError("Generated overlay changed during project command execution.", "GENERATED_OVERLAY_CONFLICT");
  }
}

export async function grant(state: RunState, capabilities: Partial<RunCapabilitiesV1>) {
  const next = revise(state.manifest, { capabilities: { ...state.manifest.capabilities, ...capabilities } });
  await persist(state, next, state.active);
}

export async function finishRun(state: RunState, status: RunManifestStatus) {
  await persist(state, revise(state.manifest, { status }), state.active);
}

export function runPlan(config: ChangeForgeConfig, options: RunOptions): RunPlanV1 {
  return {
    installDeps: Boolean(options.installDeps),
    unit: options.unit !== false,
    playwright: options.playwright !== false && config.playwright.enabled,
    differential: Boolean(options.differential),
    setupCommand: options.setupCommand ?? config.setupCommand,
    unitCommand: options.unitCommand ?? config.unitCommand,
    playwrightCommand: options.playwrightCommand ?? config.playwrightCommand
  };
}

function revise(manifest: RunManifestV1, values: Partial<RunManifestV1>) {
  const now = new Date().toISOString();
  return validateRunManifestV1({
    ...manifest,
    ...values,
    revision: manifest.revision + 1,
    updatedAt: now < manifest.updatedAt ? manifest.updatedAt : now
  });
}

async function persist(state: RunState, next: RunManifestV1, active: RunPhase | null) {
  const saved = await updateRunManifest(state.root, next.runId, state.manifest.revision, () => next);
  state.manifest = saved;
  state.active = active;
}

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
