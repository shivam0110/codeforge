import { createHash } from "node:crypto";
import path from "node:path";
import { ChangeForgeError } from "../core/errors.js";
import type { ChangeForgeConfig, ProjectDetection, RunContext } from "../core/types.js";
import { materializeRevision, type ResolvedChangeSet } from "../git/change-set.js";
import { validateGeneratedOverlayV1, type GeneratedOverlayV1 } from "../git/generated-overlay.js";
import { removeSandbox, sandboxPath } from "../git/sandbox.js";
import { detectProject } from "../project/detect.js";
import { linkLocalDependencies } from "../project/dependencies.js";
import { runSetupCommand } from "../runners/setup.js";
import { writeTextContained } from "../utils/fs.js";
import {
  DIFFERENTIAL_EXECUTION_SCHEMA_VERSION, bindDifferentialHeadOutputRoots,
  runDifferentialVerification,
  type DifferentialExecutionV1, type DifferentialRunnerOptions
} from "./differential-runner.js";
import {
  buildDifferentialResult, type DifferentialResultV1, type DifferentialSideV1
} from "./differential.js";

export interface DifferentialArtifactV1 {
  schemaVersion: typeof DIFFERENTIAL_EXECUTION_SCHEMA_VERSION;
  generatedTest: DifferentialExecutionV1["generatedTest"];
  result: DifferentialResultV1;
}

export interface DifferentialWorkflowOptions {
  context: RunContext;
  change: ResolvedChangeSet;
  project: ProjectDetection;
  config: ChangeForgeConfig;
  overlay: GeneratedOverlayV1;
  installDeps: boolean;
  setupCommand?: string | null;
  headOutputRoots?: string[];
  playwrightCommand?: string | null;
  attempt: number;
}

const runtimeConfig = ".changeforge-runtime/differential-playwright.config.ts";

export async function runDifferentialWorkflow(options: DifferentialWorkflowOptions) {
  const manager = options.project.packageManager;
  if (!manager) {
    throw new ChangeForgeError("Differential verification requires a supported package manager.", "PACKAGE_MANAGER_MISSING");
  }
  const baseRoot = await sandboxPath(options.context.originalRoot);
  try {
    await materializeRevision(options.change.root, options.change.baseSha, options.change.symlinks, baseRoot);
    const baseProject = await detectProject(baseRoot);
    if (baseProject.packageManager !== manager) {
      throw new ChangeForgeError(
        "Base and head must use the same package manager for differential verification.",
        "DIFFERENTIAL_PACKAGE_MANAGER_MISMATCH"
      );
    }
    await linkLocalDependencies(options.context.workRoot, baseRoot, manager);
    const relative = relativePath(options.context.workRoot, options.context.generatedTestFile);
    await Promise.all([
      writeRuntimeConfig(options.context.workRoot, relative, options.config),
      writeRuntimeConfig(baseRoot, relative, options.config)
    ]);
    const runnerOptions: DifferentialRunnerOptions = {
      baseRoot,
      headRoot: options.context.workRoot,
      evidenceRoot: options.context.runDir,
      generatedTestPath: relative,
      overlay: options.overlay,
      packageManager: manager,
      playwrightConfig: runtimeConfig,
      customPlaywrightCommand: options.playwrightCommand,
      timeoutMs: options.config.commandTimeoutMs,
      beforeSide: options.setupCommand ? async (side, root) => runSetupCommand(
        root,
        options.setupCommand!,
        path.join(options.context.runDir, `logs/setup-differential-${side}-${options.attempt}.log`),
        options.context.originalRoot,
        options.config.commandTimeoutMs
      ).then(() => undefined) : undefined,
      logPaths: {
        base: `logs/differential-base-${options.attempt}.log`,
        head: `logs/differential-head-${options.attempt}.log`
      }
    };
    if (options.headOutputRoots) bindDifferentialHeadOutputRoots(runnerOptions, options.headOutputRoots);
    const execution = await runDifferentialVerification(runnerOptions);
    return validateDifferentialBinding(differentialArtifact(execution), options.overlay);
  } finally {
    await removeSandbox(baseRoot);
  }
}

export function validateDifferentialArtifactV1(value: unknown): DifferentialArtifactV1 {
  const artifact = exact(value, ["schemaVersion", "generatedTest", "result"]);
  if (artifact.schemaVersion !== DIFFERENTIAL_EXECUTION_SCHEMA_VERSION) invalid();
  const generated = exact(artifact.generatedTest, ["path", "sha256", "byteLength"]);
  if (!safePath(generated.path) || !digest(generated.sha256) || !integer(generated.byteLength)) invalid();
  const result = exact(artifact.result, ["schemaVersion", "classification", "reason", "base", "head"]);
  if (result.schemaVersion !== "1.0" || typeof result.reason !== "string" || result.reason.length > 1_024) invalid();
  const base = side(result.base, "base");
  const head = side(result.head, "head");
  if (base.command !== head.command || pathIdentity(base.logPath) === pathIdentity(head.logPath)) invalid();
  if (base.command !== head.command || pathIdentity(base.logPath) === pathIdentity(head.logPath)) invalid();
  const derived = buildDifferentialResult(base, head);
  if (result.classification !== derived.classification || result.reason !== derived.reason) invalid();
  return {
    schemaVersion: DIFFERENTIAL_EXECUTION_SCHEMA_VERSION,
    generatedTest: { path: generated.path as string, sha256: generated.sha256 as string, byteLength: Number(generated.byteLength) },
    result: derived
  };
}

export function validateDifferentialBinding(value: unknown, overlayValue: unknown) {
  const artifact = validateDifferentialArtifactV1(value);
  const overlay = validateGeneratedOverlayV1(overlayValue);
  const entry = overlay.entries.length === 1 ? overlay.entries[0] : null;
  if (!entry || entry.before !== null || entry.after?.kind !== "file" || entry.path !== artifact.generatedTest.path) invalid();
  const bytes = Buffer.from(entry.after.data, "base64");
  if (bytes.length !== artifact.generatedTest.byteLength
    || createHash("sha256").update(bytes).digest("hex") !== artifact.generatedTest.sha256) invalid();
  return artifact;
}

function differentialArtifact(execution: DifferentialExecutionV1): DifferentialArtifactV1 {
  return validateDifferentialArtifactV1({
    schemaVersion: DIFFERENTIAL_EXECUTION_SCHEMA_VERSION,
    generatedTest: execution.generatedTest,
    result: execution.result
  });
}

async function writeRuntimeConfig(root: string, generated: string, config: ChangeForgeConfig) {
  await writeTextContained(
    root,
    path.join(root, runtimeConfig),
    buildDifferentialPlaywrightConfig(root, generated, config)
  );
}

export function buildDifferentialPlaywrightConfig(root: string, generated: string, config: ChangeForgeConfig) {
  if (!config.webServer.command || !config.webServer.url) {
    throw new ChangeForgeError(
      "Differential verification requires configured webServer.command and webServer.url.",
      "DIFFERENTIAL_RUNTIME_CONFIG_REQUIRED"
    );
  }
  const testFile = path.join(root, ...generated.split("/"));
  const testPattern = `^${escapeRegex(testFile)}$`;
  return `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ${JSON.stringify(path.dirname(testFile))},
  testMatch: [new RegExp(${JSON.stringify(testPattern)})],
  outputDir: ${JSON.stringify(path.join(root, ".changeforge-runtime/differential-results"))},
  timeout: 30000,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["json"]],
  webServer: {
    command: ${JSON.stringify(config.webServer.command)},
    url: ${JSON.stringify(config.webServer.url)},
    cwd: ${JSON.stringify(root)},
    timeout: ${config.webServer.timeoutMs},
    reuseExistingServer: false
  },
  use: { baseURL: ${JSON.stringify(config.webServer.url)}, trace: "on" }
});
`;
}

function relativePath(root: string, target: string) {
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new ChangeForgeError("Generated test path is outside the verification sandbox.", "DIFFERENTIAL_PATH_INVALID");
  }
  return relative;
}

function invalid(): never {
  throw new ChangeForgeError("Differential artifact is invalid.", "DIFFERENTIAL_ARTIFACT_INVALID");
}

function side(value: unknown, expected: "base" | "head"): DifferentialSideV1 {
  const data = exact(value, [
    "side", "outcome", "command", "exitCode", "durationMs", "timedOut", "signal", "errorCode",
    "counts", "errors", "stdout", "stderr", "logPath"
  ]);
  if (data.side !== expected || !["passed", "failed", "invalid"].includes(String(data.outcome))
    || !boundedString(data.command, 8_192) || !signedInteger(data.exitCode) || !integer(data.durationMs)
    || typeof data.timedOut !== "boolean" || !nullableString(data.signal, 128) || !nullableString(data.errorCode, 128)
    || !boundedString(data.stdout, 65_536) || !boundedString(data.stderr, 65_536) || !safeLogPath(data.logPath)
    || !Array.isArray(data.errors) || data.errors.length > 50
    || data.errors.some((error) => !boundedString(error, 4_096))) invalid();
  const counts = exact(data.counts, ["total", "passed", "failed", "skipped"]);
  if (![counts.total, counts.passed, counts.failed, counts.skipped].every(integer)
    || Number(counts.passed) + Number(counts.failed) + Number(counts.skipped) > Number(counts.total)) invalid();
  const outcome = data.outcome as DifferentialSideV1["outcome"];
  if (outcome === "passed" && (Number(counts.total) < 1 || data.exitCode !== 0
    || counts.total !== counts.passed || counts.failed !== 0 || counts.skipped !== 0
    || data.errors.length !== 0 || data.timedOut || data.signal || data.errorCode)) invalid();
  if (outcome === "failed" && (data.exitCode !== 1 || Number(counts.failed) < 1
    || Number(counts.total) !== Number(counts.passed) + Number(counts.failed) || counts.skipped !== 0
    || data.errors.length < 1 || data.timedOut || data.signal || data.errorCode)) invalid();
  return {
    side: expected,
    outcome,
    command: data.command as string,
    exitCode: Number(data.exitCode),
    durationMs: Number(data.durationMs),
    timedOut: data.timedOut,
    signal: data.signal as string | null,
    errorCode: data.errorCode as string | null,
    counts: {
      total: Number(counts.total), passed: Number(counts.passed),
      failed: Number(counts.failed), skipped: Number(counts.skipped)
    },
    errors: data.errors as string[],
    stdout: data.stdout as string,
    stderr: data.stderr as string,
    logPath: data.logPath as string
  };
}

function exact(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) invalid();
  return data;
}

function safePath(value: unknown) {
  return boundedString(value, 4_096) && !value.includes("\\") && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value) && path.posix.normalize(value) === value
    && value.split("/").every((part) => part && part !== "." && part !== "..") && !control(value);
}

function safeLogPath(value: unknown) {
  return safePath(value) && (value as string).startsWith("logs/");
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function integer(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function signedInteger(value: unknown) {
  return Number.isSafeInteger(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function nullableString(value: unknown, maximum: number) {
  return value === null || boundedString(value, maximum);
}

function control(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code >= 0x7f && code <= 0x9f;
  });
}

function pathIdentity(value: string) {
  return value.normalize("NFC").toLowerCase();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
