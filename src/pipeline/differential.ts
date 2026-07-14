import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIFFERENTIAL_SCHEMA_VERSION = "1.0" as const;

export type DifferentialOutcome = "passed" | "failed" | "invalid";
export type DifferentialClassification = "regression-proof" | "no-discrimination" | "regression-detected" | "invalid";

export interface DifferentialCommandResult {
  command: string;
  exitCode: number;
  exitCodeKnown?: boolean;
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | string | null;
  errorCode: string | null;
  stdout: string;
  stderr: string;
}

export interface DifferentialSideV1 {
  side: "base" | "head";
  outcome: DifferentialOutcome;
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  signal: string | null;
  errorCode: string | null;
  counts: { total: number; passed: number; failed: number; skipped: number };
  errors: string[];
  stdout: string;
  stderr: string;
  logPath: string;
}

export interface DifferentialResultV1 {
  schemaVersion: typeof DIFFERENTIAL_SCHEMA_VERSION;
  classification: DifferentialClassification;
  reason: string;
  base: DifferentialSideV1;
  head: DifferentialSideV1;
}

const MAX_REPORT_BYTES = 1_048_576;
const MAX_STORED_OUTPUT = 65_536;
const MAX_ERROR = 4_096;
const MAX_ERRORS = 50;
const MAX_TESTS = 10_000;
const MAX_DEPTH = 64;

type JsonObject = Record<string, unknown>;
type ParseState = {
  counts: DifferentialSideV1["counts"];
  errors: string[];
  invalid: boolean;
  errorOverflow: boolean;
  expected: { root: string; file: string } | null;
  matchedSpecs: number;
};

type Failure = {
  message: string;
  stack: string;
  text: string;
  location: { file: string; line?: number; column?: number } | null;
  locationProvided: boolean;
};

export function parsePlaywrightJsonSide(
  side: DifferentialSideV1["side"],
  result: DifferentialCommandResult,
  logPath: string,
  expectedSpec?: { root: string; path: string }
): DifferentialSideV1 {
  const state: ParseState = {
    counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
    errors: [],
    invalid: false,
    errorOverflow: false,
    expected: expectedSpec ? {
      root: path.resolve(expectedSpec.root),
      file: canonicalFile(expectedSpec.root, expectedSpec.path)
    } : null,
    matchedSpecs: 0
  };

  inspectProcess(result, state);
  if (Buffer.byteLength(result.stdout) > MAX_REPORT_BYTES) {
    invalidate(state, `Playwright JSON output exceeds ${MAX_REPORT_BYTES} bytes.`);
  } else {
    parseReport(result.stdout, state);
  }
  if (state.errorOverflow) state.invalid = true;

  let outcome: DifferentialOutcome = "invalid";
  if (!state.invalid && state.counts.failed > 0 && result.exitCode === 1) outcome = "failed";
  if (!state.invalid && state.counts.failed === 0 && result.exitCode === 0) outcome = "passed";
  if (!state.invalid && outcome === "invalid") invalidate(state, "Playwright exit code does not match its test results.");

  return {
    side,
    outcome,
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    signal: result.signal,
    errorCode: result.errorCode,
    counts: state.counts,
    errors: state.errors,
    stdout: cap(result.stdout, MAX_STORED_OUTPUT),
    stderr: cap(result.stderr, MAX_STORED_OUTPUT),
    logPath
  };
}

export function classifyDifferential(base: DifferentialSideV1, head: DifferentialSideV1): DifferentialClassification {
  if (base.outcome === "invalid" || head.outcome === "invalid") return "invalid";
  if (base.outcome === "failed" && head.outcome === "passed") return "regression-proof";
  if (base.outcome === "passed" && head.outcome === "passed") return "no-discrimination";
  if (base.outcome === "passed" && head.outcome === "failed") return "regression-detected";
  return "invalid";
}

export function buildDifferentialResult(base: DifferentialSideV1, head: DifferentialSideV1): DifferentialResultV1 {
  const classification = classifyDifferential(base, head);
  return {
    schemaVersion: DIFFERENTIAL_SCHEMA_VERSION,
    classification,
    reason: reasons[classification],
    base,
    head
  };
}

const reasons: Record<DifferentialClassification, string> = {
  "regression-proof": "Generated verification fails on base and passes on head.",
  "no-discrimination": "Generated verification passes on both base and head.",
  "regression-detected": "Generated verification passes on base and fails on head.",
  invalid: "Differential verification is inconclusive because one or both sides are invalid or fail together."
};

function inspectProcess(result: DifferentialCommandResult, state: ParseState) {
  if (result.timedOut) invalidate(state, "Playwright process timed out.");
  if (result.signal) invalidate(state, `Playwright process received ${result.signal}.`);
  if (result.errorCode) invalidate(state, `Playwright process error: ${result.errorCode}.`);
  if (result.exitCodeKnown === false || !Number.isInteger(result.exitCode) || ![0, 1].includes(result.exitCode)) {
    invalidate(state, "Playwright process has no valid test exit code.");
  }
}

function parseReport(source: string, state: ParseState) {
  let value: unknown;
  try {
    value = JSON.parse(source.trim().replace(/^\uFEFF/, ""));
  } catch {
    invalidate(state, "Playwright output is not valid JSON.");
    return;
  }
  if (!isObject(value)) {
    invalidate(state, "Playwright JSON report must be an object.");
    return;
  }

  if (value.stats !== undefined && !isObject(value.stats)) invalidate(state, "Playwright report stats must be an object.");
  if (isObject(value.stats) && value.stats.flaky !== undefined) {
    if (typeof value.stats.flaky !== "number" || value.stats.flaky < 0) invalidate(state, "Playwright flaky count must be non-negative.");
    else if (value.stats.flaky > 0) invalidate(state, "Flaky tests make differential verification inconclusive.");
  }

  const topErrors = value.errors;
  if (topErrors !== undefined && !Array.isArray(topErrors)) invalidate(state, "Playwright report errors must be an array.");
  if (Array.isArray(topErrors) && topErrors.length > 0) {
    invalidate(state, "Playwright reported setup or collection errors.");
    for (const error of topErrors) addError(state, errorText(error));
  }
  if (!Array.isArray(value.suites)) {
    invalidate(state, "Playwright report suites must be an array.");
    return;
  }
  for (const suite of value.suites) walkSuite(suite, state, 0);
  validateStats(value.stats, state);
  if (state.expected && state.matchedSpecs === 0) invalidate(state, "Playwright did not report the generated spec.");
  if (state.counts.total === 0) invalidate(state, "Playwright report contains no tests.");
}

function walkSuite(value: unknown, state: ParseState, depth: number) {
  if (depth > MAX_DEPTH) {
    invalidate(state, "Playwright suite nesting exceeds the supported depth.");
    return;
  }
  if (!isObject(value)) {
    invalidate(state, "Playwright suite must be an object.");
    return;
  }
  if (value.specs !== undefined && !Array.isArray(value.specs)) invalidate(state, "Playwright suite specs must be an array.");
  if (Array.isArray(value.specs)) for (const spec of value.specs) walkSpec(spec, state);
  if (value.suites !== undefined && !Array.isArray(value.suites)) invalidate(state, "Nested Playwright suites must be an array.");
  if (Array.isArray(value.suites)) for (const suite of value.suites) walkSuite(suite, state, depth + 1);
}

function walkSpec(value: unknown, state: ParseState) {
  if (!isObject(value) || !Array.isArray(value.tests) || typeof value.file !== "string" || !value.file) {
    invalidate(state, "Playwright spec tests must be an array.");
    return;
  }
  if (state.expected && canonicalFile(state.expected.root, value.file) !== state.expected.file) {
    invalidate(state, `Playwright reported an unexpected spec: ${value.file}.`);
    return;
  }
  state.matchedSpecs += 1;
  for (const test of value.tests) {
    if (state.counts.total >= MAX_TESTS) {
      invalidate(state, `Playwright report exceeds ${MAX_TESTS} tests.`);
      return;
    }
    walkTest(test, value.file, state);
  }
}

function walkTest(value: unknown, specFile: string, state: ParseState) {
  state.counts.total += 1;
  if (!isObject(value)) {
    invalidate(state, "Playwright test must be an object.");
    return;
  }

  const skippedOrFlaky = value.status === "skipped" || value.status === "flaky";
  if (!["expected", "unexpected", "skipped", "flaky"].includes(String(value.status))) {
    invalidate(state, "Playwright test status is invalid.");
  }
  if (skippedOrFlaky) state.counts.skipped += 1;
  if (value.expectedStatus !== "passed") invalidate(state, "Only tests expected to pass can prove a differential.");
  if (skippedOrFlaky) {
    invalidate(state, value.status === "flaky"
      ? "Flaky tests make differential verification inconclusive."
      : "Skipped tests make differential verification inconclusive.");
    return;
  }
  if (!Array.isArray(value.results) || value.results.length !== 1) {
    invalidate(state, "Playwright retries make differential verification inconclusive.");
    return;
  }
  const final = value.results[0];
  if (!isObject(final) || typeof final.status !== "string") {
    invalidate(state, "Playwright test has an invalid result.");
    return;
  }
  if (final.retry !== undefined && (typeof final.retry !== "number" || final.retry !== 0)) {
    invalidate(state, "Playwright retry metadata makes differential verification inconclusive.");
    return;
  }
  if (final.status === "skipped") {
    state.counts.skipped += 1;
    invalidate(state, "Skipped tests make differential verification inconclusive.");
    return;
  }
  if (final.status === "passed") {
    const failures = failureErrors(final);
    if (value.status !== "expected" || failures.length) {
      invalidate(state, "Passing Playwright result has contradictory status or errors.");
      for (const failure of failures) addError(state, failure.text);
      return;
    }
    state.counts.passed += 1;
    return;
  }
  if (final.status !== "failed") {
    invalidate(state, `Unsupported Playwright result status: ${final.status}.`);
    return;
  }
  if (value.status !== "unexpected") invalidate(state, "Failed Playwright result has contradictory test status.");

  const failures = failureErrors(final);
  if (failures.length === 0 || failures.some((failure) => !isTestFailure(failure, specFile, state))) {
    invalidate(state, "Failure outside the generated spec makes differential verification inconclusive.");
    for (const failure of failures) addError(state, failure.text);
    return;
  }
  state.counts.failed += 1;
  for (const failure of failures) addError(state, failure.text);
}

function failureErrors(result: JsonObject): Failure[] {
  const values = [
    ...(Array.isArray(result.errors) ? result.errors : []),
    ...(result.error === undefined ? [] : [result.error])
  ];
  const failures = values.map(toFailure);
  return [...new Map(failures.map((failure) => [failureKey(failure), failure])).values()];
}

function toFailure(value: unknown): Failure {
  if (typeof value === "string") {
    return { message: value, stack: value, text: value, location: null, locationProvided: false };
  }
  if (!isObject(value)) {
    const text = String(value ?? "Unknown Playwright error");
    return { message: text, stack: "", text, location: null, locationProvided: false };
  }
  const message = typeof value.message === "string" ? value.message : "Unknown Playwright error";
  const stack = typeof value.stack === "string" ? value.stack : "";
  const snippet = typeof value.snippet === "string" ? value.snippet : "";
  const location = parseLocation(value.location);
  const text = [message, stack, snippet].filter(Boolean).join("\n");
  return { message, stack, text, location, locationProvided: value.location !== undefined };
}

function parseLocation(value: unknown): Failure["location"] {
  if (!isObject(value) || typeof value.file !== "string") return null;
  return {
    file: value.file,
    ...(typeof value.line === "number" ? { line: value.line } : {}),
    ...(typeof value.column === "number" ? { column: value.column } : {})
  };
}

function failureKey(failure: Failure) {
  const message = failure.message.trim().replace(/\s+/g, " ");
  const location = failure.location
    ? `${normalizeFile(failure.location.file)}:${failure.location.line ?? ""}:${failure.location.column ?? ""}`
    : stackFiles(failure.stack).join(",");
  return `${message}\u0000${location}`;
}

function isTestFailure(failure: Failure, specFile: string, state: ParseState) {
  if (isInfrastructureFailure(failure.text)) return false;
  if (state.expected) {
    if (failure.locationProvided) {
      return failure.location !== null
        && canonicalFile(state.expected.root, failure.location.file) === state.expected.file;
    }
    return stackFiles(failure.stack).some((file) => canonicalFile(state.expected!.root, file) === state.expected!.file);
  }
  const expected = normalizeFile(specFile);
  if (failure.locationProvided) return failure.location !== null && normalizeFile(failure.location.file) === expected;
  return stackHasFrame(failure.stack, expected);
}

function validateStats(value: unknown, state: ParseState) {
  if (!isObject(value)) return;
  const expected = [
    ["expected", state.counts.passed],
    ["unexpected", state.counts.failed],
    ["skipped", state.counts.skipped]
  ] as const;
  for (const [name, count] of expected) {
    if (value[name] !== undefined && value[name] !== count) {
      invalidate(state, `Playwright report stats.${name} does not match its tests.`);
    }
  }
}

function canonicalFile(root: string, value: string) {
  let file = value;
  if (file.startsWith("file://")) {
    try {
      file = fileURLToPath(file);
    } catch {
      return "<invalid-file-url>";
    }
  }
  const resolved = path.isAbsolute(file) || path.win32.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(root, file.replaceAll("/", path.sep));
  const normalized = resolved.normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInfrastructureFailure(value: string) {
  return /\b(?:global setup|global teardown|fixture|browserType\.launch|failed to launch browser|(?:browser|page|target|context) (?:has been closed|closed|crashed)|target page, context or browser has been closed|worker process exited unexpectedly|while setting up|while tearing down|(?:before|after)(?:All|Each) hook)\b|executable (?:doesn't|does not) exist/i.test(value);
}

function stackHasFrame(stack: string, normalizedFile: string) {
  return stackFiles(stack).includes(normalizedFile);
}

function stackFiles(stack: string) {
  return stack.replaceAll("\\", "/").split("\n").flatMap((line) => {
    const parenthesized = line.match(/\((.+):\d+:\d+\)\s*$/);
    const direct = line.match(/^\s*at\s+(.+):\d+:\d+\s*$/);
    const file = parenthesized?.[1] ?? direct?.[1];
    return file === undefined ? [] : [normalizeFile(file)];
  });
}

function normalizeFile(value: string) {
  return path.posix.normalize(value.replace(/^file:\/\//, "").replaceAll("\\", "/"));
}

function errorText(value: unknown) {
  return toFailure(value).text;
}

function invalidate(state: ParseState, message: string) {
  state.invalid = true;
  addError(state, message);
}

function addError(state: ParseState, message: string) {
  if (state.errors.length < MAX_ERRORS) state.errors.push(cap(message, MAX_ERROR));
  else state.errorOverflow = true;
}

function cap(value: string, limit: number) {
  if (value.length <= limit) return value;
  const marker = "\n...[truncated]";
  return value.slice(0, limit - marker.length) + marker;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
