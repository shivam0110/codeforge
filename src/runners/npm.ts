import type { PackageManager } from "../core/types.js";
import { installDevSpec, installProjectSpec } from "../project/package-manager.js";
import { runSpec } from "./command.js";

export async function installDevDeps(root: string, pm: PackageManager, packages: string[], timeoutMs: number) {
  return runSpec(packages.length ? installDevSpec(pm, packages) : installProjectSpec(pm), { cwd: root, stream: true, timeoutMs });
}
