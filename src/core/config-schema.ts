import path from "node:path";
import { ChangeForgeError } from "./errors.js";
import type { ChangeForgeConfig } from "./types.js";

const topKeys = [
  "docsDir", "reviewDocPath", "testsDir", "repairAttempts",
  "allowSourceEdits", "commandTimeoutMs", "unitCommand",
  "setupCommand", "playwrightCommand", "allureCommand", "webServer", "codex", "playwright", "allure"
] as const;

export function validateConfig(value: unknown): ChangeForgeConfig {
  const config = record(value, "config", topKeys);
  const webServer = record(config.webServer, "webServer", ["command", "url", "timeoutMs"]);
  const codex = record(config.codex, "codex", [
    "adapter", "reasoning", "stream", "ignoreRules", "timeoutMs",
    "reviewSystemPrompt", "testGenerationSystemPrompt"
  ]);
  const playwright = record(config.playwright, "playwright", [
    "enabled", "preferStableLocators", "testFocus", "e2eTestPath"
  ]);
  const reasoning = enumeration(codex.reasoning, "codex.reasoning", ["low", "medium", "high", "xhigh"] as const);
  const legacyDefaults = ["repairAttempts", "allureCommand", "allure"].some((key) => Object.hasOwn(config, key));
  const parsed: ChangeForgeConfig = {
    docsDir: relativePath(config.docsDir, "docsDir"),
    testsDir: relativePath(config.testsDir, "testsDir"),
    allowSourceEdits: boolean(config.allowSourceEdits, "allowSourceEdits"),
    commandTimeoutMs: integer(config.commandTimeoutMs, "commandTimeoutMs", 1),
    setupCommand: nullableString(config.setupCommand ?? null, "setupCommand"),
    unitCommand: nullableString(config.unitCommand, "unitCommand"),
    playwrightCommand: nullableString(config.playwrightCommand, "playwrightCommand"),
    webServer: {
      command: nullableString(webServer.command, "webServer.command"),
      url: nullableString(webServer.url, "webServer.url"),
      timeoutMs: integer(webServer.timeoutMs, "webServer.timeoutMs", 1)
    },
    codex: {
      adapter: enumeration(codex.adapter, "codex.adapter", ["cli"] as const),
      reasoning: legacyDefaults && reasoning === "high" ? "low" : reasoning,
      stream: boolean(codex.stream, "codex.stream"),
      ignoreRules: boolean(codex.ignoreRules, "codex.ignoreRules"),
      timeoutMs: integer(codex.timeoutMs, "codex.timeoutMs", 1),
      reviewSystemPrompt: nullableString(codex.reviewSystemPrompt, "codex.reviewSystemPrompt"),
      testGenerationSystemPrompt: nullableString(codex.testGenerationSystemPrompt, "codex.testGenerationSystemPrompt")
    },
    playwright: {
      enabled: boolean(playwright.enabled, "playwright.enabled"),
      preferStableLocators: boolean(playwright.preferStableLocators, "playwright.preferStableLocators"),
      testFocus: enumeration(playwright.testFocus, "playwright.testFocus", ["edge-cases", "full"] as const),
      e2eTestPath: nullablePath(playwright.e2eTestPath, "playwright.e2eTestPath")
    }
  };
  if (Boolean(parsed.webServer.command) !== Boolean(parsed.webServer.url)) {
    invalid("webServer.command and webServer.url must be configured together.");
  }
  if (parsed.docsDir.includes("{runId}")) invalid("docsDir must be a stable owned root.");
  requireRunScope(parsed.testsDir, "testsDir");
  forbidMetadata(parsed.docsDir, "docsDir");
  forbidMetadata(parsed.testsDir, "testsDir");
  if (parsed.playwright.e2eTestPath) forbidMetadata(parsed.playwright.e2eTestPath, "playwright.e2eTestPath");
  validateOutputLayout(parsed);
  return parsed;
}

function requireRunScope(value: string, label: string) {
  if (!value.split("/").includes("{runId}")) invalid(`${label} must contain a {runId} path segment.`);
}

function forbidMetadata(value: string, label: string) {
  const parts = value.toLowerCase().split("/");
  const forbidden = new Set([".git", ".changeforge", ".changeforge-runtime", "node_modules", ".pnpm-store"]);
  if (parts.some((part) => forbidden.has(part)) || parts.some((part, index) => part === ".yarn" && parts[index + 1] === "cache")) {
    invalid(`${label} uses a reserved repository path.`);
  }
}

function validateOutputLayout(config: ChangeForgeConfig) {
  const runRoot = `${config.docsDir}/{runId}`;
  const fixedFiles = [
    `${runRoot}/code-review.md`,
    `${runRoot}/test-edge-cases.spec.ts`,
    ...(config.playwright.e2eTestPath ? [`${runRoot}/${path.posix.basename(config.playwright.e2eTestPath)}`] : [])
  ].map(expandRunId);
  if (fixedFiles.some((file, index) => fixedFiles.slice(index + 1).some((other) => overlaps(file, other)))) {
    invalid("Configured report files overlap reserved run artifacts.");
  }
  const report = expandRunId(`${runRoot}/playwright-report`);
  if (fixedFiles.some((file) => overlaps(file, report))) invalid("playwright-report overlaps a run report file.");
}

function expandRunId(value: string) {
  return value.replaceAll("{runId}", "__changeforge_run__");
}

function overlaps(left: string, right: string) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function record<const K extends readonly string[]>(value: unknown, label: string, keys: K) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const out = value as Record<string, unknown>;
  const allowed = new Set<string>(keys);
  const unknown = Object.keys(out).find((key) => !allowed.has(key));
  if (unknown) invalid(`${label}.${unknown} is not supported.`);
  return out;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean.`);
  return value;
}

function integer(value: unknown, label: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(`${label} must be an integer >= ${minimum}.`);
  return Number(value);
}

function nullableString(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) invalid(`${label} must be a non-empty string or null.`);
  return value;
}

function relativePath(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.includes("\0")) invalid(`${label} must be a non-empty relative path.`);
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) invalid(`${label} must be a relative path.`);
  const normalized = [path.posix.normalize(value.replaceAll("\\", "/")), path.win32.normalize(value)];
  if (normalized.some((item) => item === "." || item === ".." || item.startsWith(`..${path.sep}`) || item.startsWith("../") || item.startsWith("..\\"))) {
    invalid(`${label} must stay inside its configured root.`);
  }
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

function nullablePath(value: unknown, label: string) {
  return value === null ? null : relativePath(value, label);
}

function enumeration<const T extends readonly string[]>(value: unknown, label: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(`${label} must be one of: ${values.join(", ")}.`);
  return value as T[number];
}

function invalid(message: string): never {
  throw new ChangeForgeError(message, "CONFIG_INVALID", "Fix .changeforge/config.json or run changeforge init --force.");
}
