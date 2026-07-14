import path from "node:path";
import { existsContained, readJsonContained } from "../utils/fs.js";
import type { PackageManager } from "../core/types.js";
import { commandSpec } from "../runners/command.js";
import { ChangeForgeError } from "../core/errors.js";

export async function detectPackageManager(root: string, provided?: Record<string, unknown>): Promise<PackageManager> {
  const manifest = provided ?? await readJsonContained<Record<string, unknown>>(root, path.join(root, "package.json"), {});
  const declared = manifest.packageManager;
  const locks = await Promise.all([
    existsContained(root, path.join(root, "pnpm-lock.yaml")),
    existsContained(root, path.join(root, "yarn.lock")),
    existsContained(root, path.join(root, "package-lock.json"))
  ]);
  if (declared !== undefined) {
    if (typeof declared !== "string") throw new ChangeForgeError("packageManager must be a string.", "PACKAGE_MANAGER_INVALID");
    const manager = (["pnpm", "yarn", "npm"] as const).find((name) => declared === name || declared.startsWith(`${name}@`));
    if (!manager) throw new ChangeForgeError(`Unsupported package manager: ${declared}.`, "PACKAGE_MANAGER_INVALID");
    if (locks.some((present, index) => present && ["pnpm", "yarn", "npm"][index] !== manager)) {
      throw new ChangeForgeError("packageManager conflicts with the repository lockfile.", "PACKAGE_MANAGER_CONFLICT");
    }
    return manager;
  }
  if (locks.filter(Boolean).length > 1) {
    throw new ChangeForgeError("Repository contains conflicting package-manager lockfiles.", "PACKAGE_MANAGER_CONFLICT");
  }
  if (locks[0]) return "pnpm";
  if (locks[1]) return "yarn";
  return "npm";
}

export function pmRun(pm: PackageManager, script: string) {
  return pmRunSpec(pm, script).display;
}

export function pmExec(pm: PackageManager, command: string) {
  return pmExecSpec(pm, command).display;
}

export function installDevCommand(pm: PackageManager, packages: string[]) {
  return installDevSpec(pm, packages).display;
}

export function pmRunSpec(pm: PackageManager, script: string) {
  if (pm === "npm") return commandSpec("npm", script === "test" ? ["test"] : ["run", script]);
  return commandSpec(pm, script === "test" ? ["test"] : ["run", script]);
}

export function pmExecSpec(pm: PackageManager, executable: string, args: string[] = []) {
  if (pm === "npm") return commandSpec("npm", ["exec", "--offline", "--yes=false", "--", executable, ...args]);
  if (pm === "pnpm") return commandSpec("pnpm", ["exec", executable, ...args]);
  return commandSpec("yarn", ["exec", executable, ...args]);
}

export function installDevSpec(pm: PackageManager, packages: string[]) {
  if (pm === "npm") return commandSpec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-dev", ...packages]);
  if (pm === "pnpm") return commandSpec("pnpm", ["add", "--ignore-scripts", "-D", ...packages]);
  return commandSpec("yarn", ["add", "--ignore-scripts", "-D", ...packages]);
}

export function installProjectSpec(pm: PackageManager) {
  return commandSpec(pm, pm === "npm" ? ["install", "--ignore-scripts", "--no-audit", "--no-fund"] : ["install", "--ignore-scripts"]);
}
