import { constants } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ChangeForgeError } from "../core/errors.js";

export async function existsContained(root: string, filePath: string) {
  try {
    await checkedPath(root, filePath, false);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function ensureDirContained(root: string, dir: string) {
  const { base, relative } = await boundary(root, dir);
  let current = base;
  for (const part of parts(relative)) {
    current = path.join(current, part);
    try {
      const entry = await fs.lstat(current);
      if (entry.isSymbolicLink()) symlinkError(current);
      if (!entry.isDirectory()) throw new ChangeForgeError(`${current} is not a directory.`, "PATH_INVALID");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await fs.mkdir(current);
    }
  }
  return path.join(base, relative);
}

export async function readTextContained(root: string, filePath: string, fallback?: string) {
  try {
    const target = await checkedPath(root, filePath, false);
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (fallback !== undefined && isMissing(error)) return fallback;
    throw error;
  }
}

export async function readBufferContained(root: string, filePath: string) {
  return fs.readFile(await checkedPath(root, filePath, false));
}

export async function readJsonContained<T>(root: string, filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readTextContained(root, filePath)) as T;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export async function readJsonStrict<T>(root: string, filePath: string): Promise<T> {
  let text: string;
  try {
    text = await readTextContained(root, filePath);
  } catch (error) {
    const code = isMissing(error) ? "CONFIG_MISSING" : "CONFIG_READ_FAILED";
    throw new ChangeForgeError(`Cannot read ${filePath}: ${message(error)}`, code);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ChangeForgeError(`Invalid JSON in ${filePath}: ${message(error)}`, "CONFIG_INVALID");
  }
}

export async function writeTextContained(root: string, filePath: string, value: string | Buffer) {
  const parent = await ensureDirContained(root, path.dirname(filePath));
  const target = path.join(parent, path.basename(filePath));
  try {
    const entry = await fs.lstat(target);
    if (entry.isSymbolicLink()) symlinkError(target);
    if (entry.isDirectory()) throw new ChangeForgeError(`${target} is a directory.`, "PATH_INVALID");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temp = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await checkedPath(root, parent, false);
    await fs.rename(temp, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
  }
}

export async function writeJsonContained(root: string, filePath: string, value: unknown) {
  await writeTextContained(root, filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendUniqueContained(root: string, filePath: string, lines: string[]) {
  const current = await readTextContained(root, filePath, "");
  await append(current, lines, (value) => writeTextContained(root, filePath, value));
}

export async function assertSafeWritePath(root: string, target: string) {
  const parent = await checkedPath(root, path.dirname(target), true);
  const file = path.join(parent, path.basename(target));
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) symlinkError(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function removeContained(root: string, target: string) {
  let safe: string;
  try {
    safe = await checkedPath(root, target, false);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (path.resolve(safe) === path.resolve(await fs.realpath(root))) {
    throw new ChangeForgeError("Refusing to remove the containment root.", "PATH_INVALID");
  }
  await fs.rm(safe, { recursive: true, force: true });
}

export async function copyDirectoryContained(sourceRoot: string, source: string, targetRoot: string, target: string) {
  const safeSource = await checkedPath(sourceRoot, source, false);
  if (!(await fs.lstat(safeSource)).isDirectory()) throw new ChangeForgeError(`${source} is not a directory.`, "PATH_INVALID");
  await ensureDirContained(targetRoot, target);
  for (const entry of await fs.readdir(safeSource, { withFileTypes: true })) {
    const from = path.join(safeSource, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) symlinkError(from);
    if (entry.isDirectory()) await copyDirectoryContained(sourceRoot, from, targetRoot, to);
    else if (entry.isFile()) await writeTextContained(targetRoot, to, await fs.readFile(from));
    else throw new ChangeForgeError(`${from} is not a regular file.`, "PATH_INVALID");
  }
}

export async function newestDir(root: string, parent: string) {
  const safeParent = await checkedPath(root, parent, false);
  const entries = await fs.readdir(safeParent, { withFileTypes: true }).catch((error) => {
    if (isMissing(error)) return [];
    throw error;
  });
  const dirs = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const full = await checkedPath(root, path.join(safeParent, entry.name), false);
      return { name: entry.name, mtime: (await fs.lstat(full)).mtimeMs };
    })
  );
  return dirs.sort((a, b) => b.mtime - a.mtime)[0]?.name ?? null;
}

export async function directoryHasEntriesContained(root: string, directory: string) {
  try {
    const safe = await checkedPath(root, directory, false);
    if (!(await fs.lstat(safe)).isDirectory()) return false;
    return (await fs.readdir(safe)).length > 0;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function append(current: string, lines: string[], write: (value: string) => Promise<void>) {
  const seen = new Set(current.split(/\r?\n/));
  const added = lines.filter((line) => !seen.has(line));
  if (!added.length) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await write(`${current}${prefix}${added.join("\n")}\n`);
}

async function boundary(root: string, target: string) {
  const lexicalRoot = path.resolve(root);
  const rootEntry = await fs.lstat(lexicalRoot);
  if (rootEntry.isSymbolicLink()) symlinkError(lexicalRoot);
  if (!rootEntry.isDirectory()) throw new ChangeForgeError(`${lexicalRoot} is not a directory.`, "PATH_INVALID");
  const base = await fs.realpath(lexicalRoot);
  const resolvedTarget = path.resolve(target);
  let relative = path.relative(lexicalRoot, resolvedTarget);
  if (escapes(relative)) relative = path.relative(base, resolvedTarget);
  if (escapes(relative)) {
    throw new ChangeForgeError(`Path escapes ${lexicalRoot}.`, "PATH_OUTSIDE_REPO");
  }
  return { base, relative };
}

async function checkedPath(root: string, target: string, allowMissing: boolean) {
  const { base, relative } = await boundary(root, target);
  let current = base;
  for (const part of parts(relative)) {
    current = path.join(current, part);
    try {
      const entry = await fs.lstat(current);
      if (entry.isSymbolicLink()) symlinkError(current);
    } catch (error) {
      if (allowMissing && isMissing(error)) return path.join(base, relative);
      throw error;
    }
  }
  const real = await fs.realpath(current);
  const escaped = path.relative(base, real);
  if (escaped === ".." || escaped.startsWith(`..${path.sep}`)) {
    throw new ChangeForgeError(`Path escapes ${base}.`, "PATH_OUTSIDE_REPO");
  }
  return real;
}

function parts(relative: string) {
  return relative ? relative.split(path.sep).filter(Boolean) : [];
}

function escapes(relative: string) {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function symlinkError(filePath: string): never {
  throw new ChangeForgeError(`Refusing to follow symlink ${filePath}.`, "PATH_SYMLINK");
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
