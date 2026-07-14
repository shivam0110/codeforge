import type { PackageManager } from "../core/types.js";
import { pmExec, pmExecSpec, pmRun, pmRunSpec } from "./package-manager.js";

export function unitCommand(pm: PackageManager, scripts: Record<string, string>) {
  if (scripts.test) return pmRun(pm, "test");
  if (scripts["test:unit"]) return pmRun(pm, "test:unit");
  return null;
}

export function unitCommandSpec(pm: PackageManager, scripts: Record<string, string>) {
  if (scripts.test) return pmRunSpec(pm, "test");
  if (scripts["test:unit"]) return pmRunSpec(pm, "test:unit");
  return null;
}

export function playwrightCommand(pm: PackageManager) {
  return `${pmExec(pm, "playwright")} test`;
}

export function playwrightCommandSpec(pm: PackageManager, args: string[] = []) {
  return pmExecSpec(pm, "playwright", ["test", ...args]);
}
