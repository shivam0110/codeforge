import path from "node:path";
import { existsContained, readTextContained } from "../utils/fs.js";
import { ChangeForgeError } from "../core/errors.js";
import type { ProjectDetection } from "../core/types.js";
import { playwrightCommand, unitCommand } from "./test-commands.js";
import { detectPackageManager } from "./package-manager.js";
import { findPlaywrightConfig } from "./playwright.js";

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export async function detectProject(root: string): Promise<ProjectDetection> {
  const packageFile = path.join(root, "package.json");
  const hasPackageJson = await existsContained(root, packageFile);
  const packageJson = hasPackageJson ? parsePackageJson(await readTextContained(root, packageFile)) : null;
  const packageManager = packageJson ? await detectPackageManager(root, packageJson) : null;
  const scripts = packageJson?.scripts ?? {};
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
    ...(packageJson?.peerDependencies ?? {}),
    ...(packageJson?.optionalDependencies ?? {})
  };
  const playwrightConfig = await findPlaywrightConfig(root);
  const hasPlaywright = hasPackageJson && Boolean(deps["@playwright/test"]);
  const missingRecommendedDeps = hasPackageJson && !hasPlaywright ? ["@playwright/test"] : [];

  return {
    rootDir: root,
    packageManager,
    hasPackageJson,
    hasPlaywright,
    hasPlaywrightConfig: Boolean(playwrightConfig),
    scripts,
    deps,
    suggestedUnitCommand: packageManager ? unitCommand(packageManager, scripts) : null,
    suggestedPlaywrightCommand: packageManager ? playwrightCommand(packageManager) : null,
    missingRecommendedDeps,
    playwrightConfig
  };
}

function parsePackageJson(value: string): PackageJson & Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ChangeForgeError("package.json is not valid JSON.", "PACKAGE_JSON_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChangeForgeError("package.json must contain an object.", "PACKAGE_JSON_INVALID");
  }
  return parsed as PackageJson & Record<string, unknown>;
}
