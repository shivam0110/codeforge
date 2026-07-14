import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ChangeForgeError } from "../core/errors.js";
import type { CommandResult, CommandSpec, PackageManager } from "../core/types.js";
import {
  generatedOverlayState,
  replayGeneratedOverlay,
  validateGeneratedOverlayV1,
  type GeneratedOverlayV1
} from "../git/generated-overlay.js";
import { readManifest } from "../git/patch.js";
import { playwrightCommandSpec } from "../project/test-commands.js";
import { runSpec } from "../runners/command.js";
import {
  isRunOwnedOutputRoot, runOwnedOutputRoots, verificationInputChanges
} from "./input-integrity.js";
import {
  buildDifferentialResult,
  parsePlaywrightJsonSide,
  type DifferentialCommandResult,
  type DifferentialResultV1
} from "./differential.js";

export const DIFFERENTIAL_EXECUTION_SCHEMA_VERSION = "1.0" as const;
const runtimeOutput = ".changeforge-runtime/differential-results";
const MAX_COMMAND_BUFFER = 2 * 1_048_576;

export interface DifferentialRunnerOptions {
  baseRoot: string;
  headRoot: string;
  evidenceRoot: string;
  generatedTestPath: string;
  overlay: GeneratedOverlayV1;
  packageManager: PackageManager;
  playwrightConfig?: string | null;
  customPlaywrightCommand?: string | null;
  timeoutMs: number;
  logPaths?: { base: string; head: string };
  env?: NodeJS.ProcessEnv;
  beforeSide?: (side: "base" | "head", root: string) => Promise<void>;
}

const headOutputRoots = new WeakMap<DifferentialRunnerOptions, string[]>();

export function bindDifferentialHeadOutputRoots(options: DifferentialRunnerOptions, roots: string[]) {
  if (roots.some((root) => !isRunOwnedOutputRoot(root))) {
    throw new ChangeForgeError("Differential output roots are invalid.", "DIFFERENTIAL_PATH_INVALID");
  }
  headOutputRoots.set(options, [...new Set(roots)]);
  return options;
}

export interface DifferentialExecutionV1 {
  schemaVersion: typeof DIFFERENTIAL_EXECUTION_SCHEMA_VERSION;
  generatedTest: { path: string; sha256: string; byteLength: number };
  result: DifferentialResultV1;
  evidence: { base: CommandResult; head: CommandResult };
}

export function differentialPlaywrightSpec(
  packageManager: PackageManager,
  generatedTestPath: string,
  playwrightConfig?: string | null
): CommandSpec {
  const target = safeRelative(generatedTestPath);
  const args: string[] = [];
  if (playwrightConfig) args.push("--config", safeConfigPath(playwrightConfig));
  args.push(
    `${escapeRegex(target)}$`,
    "--no-deps", "--repeat-each=1", "--forbid-only", "--update-snapshots=none",
    `--output=${runtimeOutput}`, "--trace=on", "--reporter=json", "--retries=0", "--workers=1"
  );
  return playwrightCommandSpec(packageManager, args);
}

export async function runDifferentialVerification(options: DifferentialRunnerOptions): Promise<DifferentialExecutionV1> {
  if (options.customPlaywrightCommand?.trim()) {
    throw new ChangeForgeError(
      "Differential verification requires a direct Playwright command.",
      "DIFFERENTIAL_CUSTOM_COMMAND_UNSUPPORTED"
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new ChangeForgeError("Differential timeout must be a positive integer.", "DIFFERENTIAL_TIMEOUT_INVALID");
  }

  const generatedTestPath = safeRelative(options.generatedTestPath);
  const overlay = validateGeneratedOverlayV1(options.overlay);
  const generated = frozenTest(overlay, generatedTestPath);
  const command = differentialPlaywrightSpec(options.packageManager, generatedTestPath, options.playwrightConfig);
  const logs = {
    base: safeRelative(options.logPaths?.base ?? "logs/differential-base.log"),
    head: safeRelative(options.logPaths?.head ?? "logs/differential-head.log")
  };
  if (pathIdentity(logs.base) === pathIdentity(logs.head)) {
    throw new ChangeForgeError("Differential evidence paths must be distinct.", "DIFFERENTIAL_PATH_INVALID");
  }
  await validateRoots(options.baseRoot, options.headRoot, options.evidenceRoot);
  await assertFrozen(options.headRoot, overlay, "DIFFERENTIAL_GENERATED_TEST_MISMATCH");
  await assertState(
    options.baseRoot,
    overlay,
    "before",
    "DIFFERENTIAL_BASE_PREIMAGE_MISMATCH",
    "Generated sidecar path does not match its base preimage."
  );
  await replayGeneratedOverlay(options.baseRoot, overlay);
  await assertFrozen(options.baseRoot, overlay, "DIFFERENTIAL_GENERATED_TEST_MISMATCH");

  const env = noColorEnv(options.env);
  const base = await executeSide("base", options.baseRoot, logs.base, command, overlay, options, env);
  const head = await executeSide("head", options.headRoot, logs.head, command, overlay, options, env);
  const result = buildDifferentialResult(
    parsePlaywrightJsonSide("base", reported(base, command), logs.base, {
      root: options.baseRoot, path: generatedTestPath
    }),
    parsePlaywrightJsonSide("head", reported(head, command), logs.head, {
      root: options.headRoot, path: generatedTestPath
    })
  );

  return {
    schemaVersion: DIFFERENTIAL_EXECUTION_SCHEMA_VERSION,
    generatedTest: {
      path: generatedTestPath,
      sha256: createHash("sha256").update(generated).digest("hex"),
      byteLength: generated.byteLength
    },
    result,
    evidence: { base, head }
  };
}

async function executeSide(
  side: "base" | "head",
  root: string,
  logPath: string,
  command: CommandSpec,
  overlay: GeneratedOverlayV1,
  options: DifferentialRunnerOptions,
  env: NodeJS.ProcessEnv
) {
  await assertFrozen(root, overlay, "DIFFERENTIAL_GENERATED_TEST_MISMATCH");
  const outputRoots = side === "head" && headOutputRoots.has(options)
    ? headOutputRoots.get(options)!
    : await runOwnedOutputRoots(root);
  const readInputs = () => readManifest(root, null, outputRoots);
  if (options.beforeSide) {
    const setupInput = await readInputs();
    await options.beforeSide(side, root);
    const changed = verificationInputChanges(setupInput, await readInputs());
    if (changed.length) {
      throw new ChangeForgeError(
        `Differential setup changed project files: ${changed.join(", ")}`,
        "DIFFERENTIAL_SETUP_MUTATED"
      );
    }
  }
  const before = await readInputs();
  let result = await runSpec(command, {
    cwd: root,
    env,
    extendEnv: false,
    check: false,
    logFile: path.join(options.evidenceRoot, ...logPath.split("/")),
    logRoot: options.evidenceRoot,
    timeoutMs: options.timeoutMs,
    maxBuffer: MAX_COMMAND_BUFFER
  });
  try {
    await assertFrozen(root, overlay, "DIFFERENTIAL_GENERATED_TEST_MUTATED");
  } catch (error) {
    if (!(error instanceof ChangeForgeError) || error.code !== "DIFFERENTIAL_GENERATED_TEST_MUTATED") throw error;
    result = {
      ...result,
      failed: true,
      errorCode: error.code,
      stderr: [result.stderr, error.message].filter(Boolean).join("\n")
    };
  }
  const changed = verificationInputChanges(before, await readInputs());
  if (changed.length && result.errorCode !== "DIFFERENTIAL_GENERATED_TEST_MUTATED") {
    result = {
      ...result,
      failed: true,
      errorCode: "DIFFERENTIAL_SOURCE_MUTATED",
      stderr: [result.stderr, `Differential command changed project files: ${changed.join(", ")}`]
        .filter(Boolean).join("\n")
    };
  }
  return result;
}

function reported(result: CommandResult, command: CommandSpec): DifferentialCommandResult {
  return {
    command: command.display,
    exitCode: result.exitCode,
    exitCodeKnown: result.exitCodeKnown,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    signal: result.signal,
    errorCode: result.errorCode,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function frozenTest(overlay: GeneratedOverlayV1, generatedTestPath: string) {
  if (overlay.entries.length !== 1) {
    throw new ChangeForgeError("Differential verification requires a single generated sidecar.", "DIFFERENTIAL_OVERLAY_INVALID");
  }
  const entry = overlay.entries[0];
  if (entry.path !== generatedTestPath || entry.before !== null || entry.after?.kind !== "file") {
    throw new ChangeForgeError("Frozen overlay does not contain the generated sidecar.", "DIFFERENTIAL_OVERLAY_INVALID");
  }
  return Buffer.from(entry.after.data, "base64");
}

async function assertFrozen(root: string, overlay: GeneratedOverlayV1, code: string) {
  return assertState(root, overlay, "after", code, "Generated sidecar no longer matches the frozen overlay.");
}

async function assertState(
  root: string,
  overlay: GeneratedOverlayV1,
  expected: "before" | "after",
  code: string,
  message: string
) {
  try {
    if (await generatedOverlayState(root, overlay) === expected) return;
  } catch (error) {
    if (!(error instanceof ChangeForgeError) || error.code !== "GENERATED_OVERLAY_CONFLICT") throw error;
  }
  throw new ChangeForgeError(message, code);
}

async function validateRoots(baseRoot: string, headRoot: string, evidenceRoot: string) {
  const [base, head, evidence] = await Promise.all([
    realDirectory(baseRoot), realDirectory(headRoot), realDirectory(evidenceRoot)
  ]);
  if (overlaps(base, head) || overlaps(base, evidence) || overlaps(head, evidence)) {
    throw new ChangeForgeError("Differential roots and evidence must be isolated.", "DIFFERENTIAL_ROOT_INVALID");
  }
}

async function realDirectory(root: string) {
  const entry = await fs.lstat(root).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new ChangeForgeError("Differential roots must be real directories.", "DIFFERENTIAL_ROOT_INVALID");
  }
  return fs.realpath(root);
}

function overlaps(left: string, right: string) {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return contained(relative) || contained(reverse);
}

function contained(relative: string) {
  return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeRelative(value: string) {
  const parts = value.split("/");
  if (!value || value.includes("\\") || path.posix.normalize(value) !== value
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || control(value)
    || parts.some((part) => !part || [".", "..", ".git", ".changeforge", ".changeforge-runtime", "node_modules"]
      .includes(part.normalize("NFC").toLowerCase()))) {
    throw new ChangeForgeError(`Unsafe differential path: ${value}.`, "DIFFERENTIAL_PATH_INVALID");
  }
  return value;
}

function safeConfigPath(value: string) {
  if (value === ".changeforge-runtime/differential-playwright.config.ts") return value;
  return safeRelative(value);
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

function noColorEnv(provided?: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...provided, FORCE_COLOR: "0" };
  delete env.NO_COLOR;
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper === "PWDEBUG" || upper === "NODE_OPTIONS" || upper === "NODE_PATH"
      || upper === "PLAYWRIGHT_FORCE_TTY" || upper === "PLAYWRIGHT_LAST_RUN_OUTPUT_FILE"
      || upper.startsWith("PLAYWRIGHT_JSON_OUTPUT_")) delete env[name];
  }
  return env;
}
