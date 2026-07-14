import fs from "node:fs/promises";
import path from "node:path";
import type { PackageManager } from "../core/types.js";
import { ChangeForgeError } from "../core/errors.js";

export function dependencyLinkType(
  platform: NodeJS.Platform,
): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

export async function linkLocalDependencies(
  sourceRoot: string,
  workRoot: string,
  pm: PackageManager,
) {
  const source = path.resolve(sourceRoot, "node_modules");
  const target = path.resolve(workRoot, "node_modules");
  const sourceEntry = await fs
    .stat(source)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
  if (!sourceEntry?.isDirectory()) {
    throw new ChangeForgeError(
      `Local dependencies are missing at ${source}. Run \`${pm} install\` in the source repository or use \`--install-deps\`.`,
      "DEPENDENCIES_MISSING",
    );
  }

  if (await targetExists(target)) {
    if (await linksTo(target, source)) return target;
    throw unexpectedTarget(target, source);
  }

  try {
    await fs.symlink(source, target, dependencyLinkType(process.platform));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await linksTo(target, source))
    )
      throw error;
  }
  return target;
}

async function targetExists(target: string) {
  return fs.lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

async function linksTo(target: string, source: string) {
  const entry = await fs.lstat(target).catch(() => null);
  if (!entry?.isSymbolicLink()) return false;
  const [actual, expected] = await Promise.all([
    fs.realpath(target).catch(() => null),
    fs.realpath(source),
  ]);
  return actual === expected;
}

function unexpectedTarget(target: string, source: string) {
  return new ChangeForgeError(
    `Refusing to replace ${target}; expected a dependency link to ${source}.`,
    "DEPENDENCIES_TARGET_EXISTS",
  );
}
