import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { ChangeForgeError } from "../core/errors.js";

export async function makeSecureTemp(prefix: string, forbiddenRoots: string[] = []) {
  for (const base of await usableBases()) {
    if (await hasInheritedProjectState(base)) continue;
    const dir = await fs.mkdtemp(path.join(base, prefix));
    await fs.chmod(dir, 0o700).catch(() => undefined);
    if (forbiddenRoots.some((root) => overlaps(dir, root))) {
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }
    return dir;
  }
  throw new ChangeForgeError("No isolated system temporary directory is available.", "SANDBOX_UNAVAILABLE");
}

export async function removeSecureTemp(dir: string, prefix: string) {
  const target = path.resolve(dir);
  const parent = await fs.realpath(path.dirname(target)).catch(() => "");
  if (!path.basename(target).startsWith(prefix) || !(await usableBases()).includes(parent)) {
    throw new ChangeForgeError("Refusing to remove a path outside the secure temporary root.", "PATH_OUTSIDE_REPO");
  }
  const entry = await fs.lstat(target).catch(() => null);
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new ChangeForgeError(`Refusing to follow symlink ${target}.`, "PATH_SYMLINK");
  await fs.rm(target, { recursive: true, force: true });
}

async function usableBases() {
  const candidates = process.platform === "win32" ? [os.tmpdir()] : ["/tmp", "/var/tmp", os.tmpdir()];
  const found: string[] = [];
  for (const candidate of candidates) {
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || found.includes(real)) continue;
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isDirectory()) continue;
    if (await fs.access(real, constants.W_OK | constants.X_OK).then(() => false, () => true)) continue;
    found.push(real);
  }
  return found;
}

async function hasInheritedProjectState(dir: string) {
  let current = path.resolve(dir);
  while (true) {
    for (const name of [".git", "node_modules"]) {
      if (await fs.lstat(path.join(current, name)).then(() => true, () => false)) return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function overlaps(left: string, right: string) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return inside(a, b) || inside(b, a);
}

function inside(target: string, root: string) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
