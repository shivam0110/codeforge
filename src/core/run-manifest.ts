import path from "node:path";
import { validateConfig } from "./config-schema.js";
import { ChangeForgeError } from "./errors.js";
import type { ChangeForgeConfig, ChangeInput } from "./types.js";

export const RUN_MANIFEST_SCHEMA_VERSION = "1.0" as const;
export const RUN_MANIFEST_FILE = "run-manifest.v1.json";
export const RUN_PHASES = ["resolve", "review", "generate", "execute", "differential", "apply"] as const;

export type RunPhase = typeof RUN_PHASES[number];
export type RunPhaseStatus = "pending" | "running" | "completed" | "skipped" | "failed";
export type RunManifestStatus = "running" | "partial" | "passed" | "failed";

export interface RunPhaseState {
  status: RunPhaseStatus;
  attempts: number;
  updatedAt: string;
  reason: string | null;
}

export interface RunArtifactV1 {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RunPlanV1 {
  installDeps: boolean;
  unit: boolean;
  playwright: boolean;
  differential: boolean;
  setupCommand: string | null;
  unitCommand: string | null;
  playwrightCommand: string | null;
}

export interface RunCapabilitiesV1 {
  generate: boolean;
  execute: boolean;
  installDependencies: boolean;
  differential: boolean;
  apply: boolean;
}

export interface RunManifestV1 {
  schemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION;
  runId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  input: ChangeInput;
  resolved: { baseSha: string; headSha: string; changeSha256: string };
  executionBoundary: "checkout-isolated";
  config: ChangeForgeConfig;
  plan: RunPlanV1;
  capabilities: RunCapabilitiesV1;
  phases: Record<RunPhase, RunPhaseState>;
  artifacts: Record<string, RunArtifactV1>;
  status: RunManifestStatus;
}

export interface CreateRunManifestV1Params {
  runId: string;
  input: ChangeInput;
  resolved: RunManifestV1["resolved"];
  config: ChangeForgeConfig;
  plan: RunPlanV1;
  capabilities: RunCapabilitiesV1;
  now?: Date;
}

export interface SetPhaseOptions {
  reason?: string | null;
  now?: Date;
  force?: boolean;
}

const topKeys = [
  "schemaVersion", "runId", "createdAt", "updatedAt", "revision", "input", "resolved",
  "executionBoundary", "config", "plan", "capabilities", "phases", "artifacts", "status"
] as const;

export function createRunManifestV1(params: CreateRunManifestV1Params): RunManifestV1 {
  const now = isoDate(params.now ?? new Date(), "now");
  const phases = Object.fromEntries(RUN_PHASES.map((phase) => [phase, {
    status: "pending", attempts: 0, updatedAt: now, reason: null
  }])) as Record<RunPhase, RunPhaseState>;
  return validateRunManifestV1({
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runId: params.runId,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    input: params.input,
    resolved: params.resolved,
    executionBoundary: "checkout-isolated",
    config: params.config,
    plan: params.plan,
    capabilities: params.capabilities,
    phases,
    artifacts: {},
    status: "running"
  });
}

export function validateRunManifestV1(value: unknown): RunManifestV1 {
  try {
    const data = object(value, "manifest", topKeys);
    literal(data.schemaVersion, "schemaVersion", RUN_MANIFEST_SCHEMA_VERSION);
    const runId = safeName(data.runId, "runId", 160);
    const createdAt = isoString(data.createdAt, "createdAt");
    const updatedAt = isoString(data.updatedAt, "updatedAt");
    if (updatedAt < createdAt) invalid("updatedAt cannot precede createdAt.");
    const phases = parsePhases(data.phases, createdAt, updatedAt);
    const capabilities = parseCapabilities(data.capabilities);
    const status = enumeration(data.status, "status", ["running", "partial", "passed", "failed"]);
    validateState(status, phases, capabilities);
    return {
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      runId,
      createdAt,
      updatedAt,
      revision: integer(data.revision, "revision"),
      input: parseInput(data.input),
      resolved: parseResolved(data.resolved),
      executionBoundary: literal(data.executionBoundary, "executionBoundary", "checkout-isolated"),
      config: parseConfig(data.config),
      plan: parsePlan(data.plan),
      capabilities,
      phases,
      artifacts: parseArtifacts(data.artifacts),
      status
    };
  } catch (error) {
    if (error instanceof ChangeForgeError && ["RUN_MANIFEST_INVALID", "RUN_ARTIFACT_INVALID"].includes(error.code)) throw error;
    invalid(error instanceof Error ? error.message : String(error));
  }
}

export function setPhase(
  manifest: RunManifestV1,
  phase: RunPhase,
  status: RunPhaseStatus,
  options: SetPhaseOptions = {}
): RunManifestV1 {
  const current = validateRunManifestV1(manifest);
  const { reason = null, now = new Date(), force = false } = options;
  if (!RUN_PHASES.includes(phase)) invalid(`Unknown phase: ${String(phase)}.`);
  enumeration(status, "phase status", ["pending", "running", "completed", "skipped", "failed"]);
  if (reason !== null && typeof reason !== "string") invalid("Phase reason must be a string or null.");
  const updatedAt = isoDate(now, "now");
  if (updatedAt < current.updatedAt) invalid("Phase time cannot precede the manifest update time.");
  const from = current.phases[phase].status;
  if (!allowedTransition(from, status, force)) invalid(`Cannot transition ${phase} from ${from} to ${status}.`);
  const phases = {
    ...current.phases,
    [phase]: {
      status,
      attempts: current.phases[phase].attempts + (status === "running" ? 1 : 0),
      updatedAt,
      reason
    }
  };
  const nextStatus = status === "failed" ? "failed"
    : status === "running" ? Object.values(phases).some((item) => item.status === "failed") ? "failed" : "running"
      : current.status;
  return validateRunManifestV1({
    ...current,
    updatedAt,
    revision: current.revision + 1,
    status: nextStatus,
    phases
  });
}

function parseInput(value: unknown): ChangeInput {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid("input must be an object.");
  if (data.kind === "working-tree") {
    object(data, "input", ["kind"]);
    return { kind: "working-tree" };
  }
  object(data, "input", ["kind", "value"]);
  const kind = enumeration(data.kind, "input.kind", ["range", "commit", "file"]);
  return { kind, value: nonemptyString(data.value, "input.value") };
}

function parseResolved(value: unknown) {
  const data = object(value, "resolved", ["baseSha", "headSha", "changeSha256"]);
  const baseSha = objectId(data.baseSha, "resolved.baseSha");
  const headSha = objectId(data.headSha, "resolved.headSha");
  if (baseSha.length !== headSha.length) invalid("resolved object IDs must use the same hash format.");
  return { baseSha, headSha, changeSha256: lowerDigest(data.changeSha256, "resolved.changeSha256") };
}

function parseConfig(value: unknown) {
  try {
    return validateConfig(value);
  } catch (error) {
    invalid(`config is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsePlan(value: unknown): RunPlanV1 {
  const required = [
    "installDeps", "unit", "playwright", "differential",
    "unitCommand", "playwrightCommand"
  ] as const;
  const data = object(value, "plan");
  const allowed = new Set<string>([...required, "setupCommand", "allure", "allureCommand"]);
  const unknown = Object.keys(data).find((key) => !allowed.has(key));
  if (unknown) invalid(`plan.${unknown} is not supported.`);
  const missing = required.find((key) => !Object.hasOwn(data, key));
  if (missing) invalid(`plan.${missing} is required.`);
  return {
    installDeps: boolean(data.installDeps, "plan.installDeps"),
    unit: boolean(data.unit, "plan.unit"),
    playwright: boolean(data.playwright, "plan.playwright"),
    differential: boolean(data.differential, "plan.differential"),
    setupCommand: nullableString(data.setupCommand ?? null, "plan.setupCommand"),
    unitCommand: nullableString(data.unitCommand, "plan.unitCommand"),
    playwrightCommand: nullableString(data.playwrightCommand, "plan.playwrightCommand")
  };
}

function parseCapabilities(value: unknown): RunCapabilitiesV1 {
  const keys = ["generate", "execute", "installDependencies", "differential", "apply"] as const;
  const data = object(value, "capabilities", keys);
  return {
    generate: boolean(data.generate, "capabilities.generate"),
    execute: boolean(data.execute, "capabilities.execute"),
    installDependencies: boolean(data.installDependencies, "capabilities.installDependencies"),
    differential: boolean(data.differential, "capabilities.differential"),
    apply: boolean(data.apply, "capabilities.apply")
  };
}

function parsePhases(value: unknown, createdAt: string, updatedAt: string) {
  const data = object(value, "phases", RUN_PHASES);
  let running = 0;
  const phases = Object.fromEntries(RUN_PHASES.map((phase) => {
    const state = object(data[phase], `phases.${phase}`, ["status", "attempts", "updatedAt", "reason"]);
    const phaseTime = isoString(state.updatedAt, `phases.${phase}.updatedAt`);
    if (phaseTime < createdAt || phaseTime > updatedAt) invalid(`phases.${phase}.updatedAt is outside the manifest lifetime.`);
    const status = enumeration(state.status, `phases.${phase}.status`, ["pending", "running", "completed", "skipped", "failed"]);
    const attempts = integer(state.attempts, `phases.${phase}.attempts`);
    if (!attempts && !["pending", "skipped"].includes(status)) invalid(`phases.${phase} requires an attempt.`);
    if (status === "running") running += 1;
    return [phase, {
      status,
      attempts,
      updatedAt: phaseTime,
      reason: nullableString(state.reason, `phases.${phase}.reason`, true)
    }];
  })) as Record<RunPhase, RunPhaseState>;
  if (running > 1) invalid("Only one phase may be running.");
  return phases;
}

function parseArtifacts(value: unknown) {
  try {
    const data = object(value, "artifacts");
    const artifacts: Record<string, RunArtifactV1> = {};
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const [name, value] of Object.entries(data)) {
      portableName(name, "artifact name", 80, artifactInvalid);
      const canonical = name.toLowerCase();
      if (names.has(canonical)) artifactInvalid(`Artifact name ${name} differs only by case.`);
      names.add(canonical);
      const entry = object(value, `artifacts.${name}`, ["path", "sha256", "bytes"]);
      const artifactFile = artifactPath(entry.path, `artifacts.${name}.path`);
      const canonicalPath = artifactFile.toLowerCase();
      if (paths.has(canonicalPath)) artifactInvalid(`Artifact path ${artifactFile} differs only by case or is reused.`);
      paths.add(canonicalPath);
      artifacts[name] = {
        path: artifactFile,
        sha256: artifactDigest(entry.sha256, `artifacts.${name}.sha256`),
        bytes: artifactInteger(entry.bytes, `artifacts.${name}.bytes`)
      };
    }
    return artifacts;
  } catch (error) {
    if (error instanceof ChangeForgeError && error.code === "RUN_ARTIFACT_INVALID") throw error;
    artifactInvalid(error instanceof Error ? error.message : String(error));
  }
}

function artifactPath(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) artifactInvalid(`${label} must be a POSIX relative path.`);
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.normalize(value) !== value) artifactInvalid(`${label} must stay inside the run directory.`);
  const parts = value.split("/");
  if (parts.some((part) => !portableSegment(part)) || value.toLowerCase() === RUN_MANIFEST_FILE) {
    artifactInvalid(`${label} must use portable segments and cannot reference the manifest.`);
  }
  return value;
}

function object<const K extends readonly string[]>(value: unknown, label: string, keys?: K): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const data = value as Record<string, unknown>;
  if (keys) {
    const allowed = new Set<string>(keys);
    const unknown = Object.keys(data).find((key) => !allowed.has(key));
    if (unknown) invalid(`${label}.${unknown} is not supported.`);
    const missing = keys.find((key) => !Object.hasOwn(data, key));
    if (missing) invalid(`${label}.${missing} is required.`);
  }
  return data;
}

function safeName(value: unknown, label: string, maximum: number) {
  return portableName(value, label, maximum, invalid);
}

function portableName(value: unknown, label: string, maximum: number, fail: (message: string) => never) {
  if (
    typeof value !== "string" || value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || !portableSegment(value) ||
    ["__proto__", "constructor", "prototype"].includes(value.toLowerCase())
  ) fail(`${label} is invalid.`);
  return value;
}

function portableSegment(value: string) {
  const stem = value.split(".", 1)[0]!.replace(/[ .]+$/g, "").toUpperCase();
  return Boolean(value) && value !== "." && value !== ".." &&
    !/[<>:"|?*]/.test(value) && ![...value].some((character) => character.charCodeAt(0) < 32) && !/[ .]$/.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|¹|²|³)|LPT(?:[1-9]|¹|²|³))$/.test(stem);
}

function objectId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value)) invalid(`${label} must be a 40 or 64 character hex digest.`);
  return value.toLowerCase();
}

function lowerDigest(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function artifactDigest(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) artifactInvalid(`${label} must be a SHA-256 digest.`);
  return value.toLowerCase();
}

function artifactInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) artifactInvalid(`${label} must be a nonnegative integer.`);
  return Number(value);
}

function isoString(value: unknown, label: string) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(`${label} must be an ISO timestamp.`);
  return value;
}

function isoDate(value: Date, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) invalid(`${label} must be a valid date.`);
  return value.toISOString();
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean.`);
  return value;
}

function integer(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${label} must be a nonnegative integer.`);
  return Number(value);
}

function nonemptyString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) invalid(`${label} must be a non-empty string.`);
  return value;
}

function nullableString(value: unknown, label: string, allowEmpty = false) {
  if (value === null) return null;
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0")) invalid(`${label} must be a string or null.`);
  return value;
}

function enumeration<const T extends readonly string[]>(value: unknown, label: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(`${label} must be one of: ${values.join(", ")}.`);
  return value as T[number];
}

function literal<const T extends string>(value: unknown, label: string, expected: T): T {
  if (value !== expected) invalid(`${label} must be ${expected}.`);
  return expected;
}

function allowedTransition(from: RunPhaseStatus, to: RunPhaseStatus, force: boolean) {
  return (from === "pending" && ["running", "skipped"].includes(to)) ||
    (["skipped", "failed"].includes(from) && to === "running") ||
    (from === "completed" && to === "running" && force) ||
    (from === "running" && ["completed", "failed"].includes(to));
}

function validateState(status: RunManifestStatus, phases: Record<RunPhase, RunPhaseState>, capabilities: RunCapabilitiesV1) {
  const states = Object.values(phases);
  const running = states.some((phase) => phase.status === "running");
  const failed = states.some((phase) => phase.status === "failed");
  if (status === "passed" && (running || failed || phases.execute.status !== "completed")) invalid("A passed run requires completed execution and no running or failed phase.");
  if (status === "failed" && !failed) invalid("A failed run requires a failed phase.");
  if (status === "partial" && (running || failed)) invalid("A partial run cannot contain running or failed phases.");
  if (status === "running" && failed) invalid("A running run cannot contain a failed phase.");
  for (const phase of ["generate", "execute", "differential", "apply"] as const) {
    if (phases[phase].status === "completed" && !capabilities[phase]) invalid(`Completed ${phase} requires its capability.`);
  }
}

function invalid(message: string): never {
  throw new ChangeForgeError(`Invalid run manifest: ${message}`, "RUN_MANIFEST_INVALID");
}

function artifactInvalid(message: string): never {
  throw new ChangeForgeError(`Invalid run artifact: ${message}`, "RUN_ARTIFACT_INVALID");
}
