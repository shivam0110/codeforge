import path from "node:path";
import { ChangeForgeError } from "./errors.js";
import { readJsonStrict } from "../utils/fs.js";
import type { ChangeForgeConfig } from "./types.js";
import { validateConfig } from "./config-schema.js";

export const defaultConfig: ChangeForgeConfig = {
  docsDir: "changeforge",
  testsDir: "changeforge/{runId}",
  allowSourceEdits: false,
  commandTimeoutMs: 600000,
  setupCommand: null,
  unitCommand: null,
  playwrightCommand: null,
  webServer: { command: null, url: null, timeoutMs: 120000 },
  codex: {
    adapter: "cli",
    reasoning: "low",
    stream: false,
    ignoreRules: false,
    timeoutMs: 300000,
    reviewSystemPrompt: null,
    testGenerationSystemPrompt: null
  },
  playwright: {
    enabled: true,
    preferStableLocators: true,
    testFocus: "edge-cases",
    e2eTestPath: null
  }
};

export async function loadConfig(root: string, options: { required?: boolean } = {}) {
  const file = path.join(root, ".changeforge/config.json");
  let user: Partial<ChangeForgeConfig>;
  try {
    user = await readJsonStrict<Partial<ChangeForgeConfig>>(root, file);
  } catch (error) {
    if (error instanceof ChangeForgeError && error.code === "CONFIG_MISSING") {
      if (options.required === false) return defaultConfig;
      throw new ChangeForgeError("ChangeForge config not found.", "CONFIG_MISSING", "Run:\n  changeforge init");
    }
    throw error;
  }
  return validateConfig(merge(defaultConfig, user));
}

function merge(base: unknown, next: unknown): unknown {
  if (next === undefined) return base;
  if (!isRecord(base) || !isRecord(next)) return next;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new ChangeForgeError(`Unsafe config key: ${key}.`, "CONFIG_INVALID");
    }
    out[key] = merge(out[key], value);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
