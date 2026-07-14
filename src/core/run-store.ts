import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ChangeForgeError } from "./errors.js";
import { runDir } from "./paths.js";
import {
  RUN_MANIFEST_FILE,
  type RunArtifactV1,
  type RunManifestV1,
  validateRunManifestV1
} from "./run-manifest.js";
import { ensureDirContained, existsContained, readBufferContained, readTextContained, writeJsonContained } from "../utils/fs.js";

export const RUN_LOCK_MALFORMED_STALE_MS = 5 * 60_000;

interface LockOwner {
  pid: number;
  createdAt: string;
  token: string;
}

export function runManifestPath(root: string, runId: string) {
  assertRunId(runId);
  return path.join(runDir(root, runId), RUN_MANIFEST_FILE);
}

export async function loadRunManifest(root: string, runId: string): Promise<RunManifestV1> {
  const file = runManifestPath(root, runId);
  let source: string;
  try {
    source = await readTextContained(root, file);
  } catch (error) {
    if (isMissing(error)) throw new ChangeForgeError(`Run manifest not found for ${runId}.`, "RUN_MANIFEST_MISSING");
    throw new ChangeForgeError(`Cannot read run manifest: ${message(error)}`, "RUN_MANIFEST_READ_FAILED");
  }
  try {
    return validateRunManifestV1(JSON.parse(source));
  } catch (error) {
    throw manifestError(error);
  }
}

export async function saveRunManifest(root: string, manifest: RunManifestV1) {
  const valid = validateRunManifestV1(manifest);
  await writeJsonContained(root, runManifestPath(root, valid.runId), valid);
  return valid;
}

export async function recordArtifact(
  root: string,
  manifest: RunManifestV1,
  name: string,
  filePath: string,
  now = new Date()
): Promise<RunManifestV1> {
  const valid = validateRunManifestV1(manifest);
  const base = runDir(root, valid.runId);
  const target = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(base, filePath);
  const relative = relativeArtifactPath(base, target);
  validateArtifact(valid, name, { path: relative, sha256: "0".repeat(64), bytes: 0 });
  const buffer = await artifactBuffer(base, target);
  const updatedAt = timestamp(now);
  const updated = {
    ...valid,
    updatedAt: updatedAt < valid.updatedAt ? valid.updatedAt : updatedAt,
    revision: valid.revision + 1,
    artifacts: {
      ...valid.artifacts,
      [name]: { path: relative, sha256: hash(buffer), bytes: buffer.length }
    }
  };
  return validateRunManifestV1(updated);
}

export async function verifyArtifact(root: string, manifest: RunManifestV1, name: string): Promise<RunArtifactV1> {
  return (await readVerifiedArtifact(root, manifest, name)).artifact;
}

export async function readVerifiedArtifact(
  root: string,
  manifest: RunManifestV1,
  name: string
): Promise<{ artifact: RunArtifactV1; bytes: Buffer }> {
  const valid = validateRunManifestV1(manifest);
  const artifact = Object.hasOwn(valid.artifacts, name) ? valid.artifacts[name] : undefined;
  if (!artifact) throw new ChangeForgeError(`Run artifact ${name} is not recorded.`, "RUN_ARTIFACT_INVALID");
  const base = runDir(root, valid.runId);
  const buffer = await artifactBuffer(base, path.resolve(base, artifact.path));
  if (buffer.length !== artifact.bytes || hash(buffer) !== artifact.sha256.toLowerCase()) {
    throw new ChangeForgeError(`Run artifact ${name} failed integrity verification.`, "RUN_ARTIFACT_INVALID");
  }
  return { artifact, bytes: buffer };
}

export async function verifyArtifacts(root: string, manifest: RunManifestV1) {
  const valid = validateRunManifestV1(manifest);
  const verified: Record<string, RunArtifactV1> = {};
  for (const name of Object.keys(valid.artifacts).sort()) verified[name] = await verifyArtifact(root, valid, name);
  return verified;
}

export async function updateRunManifest(
  root: string,
  runId: string,
  expectedRevision: number,
  update: (manifest: RunManifestV1) => RunManifestV1 | Promise<RunManifestV1>
) {
  return withRunLock(root, runId, "manifest", async () => {
    const current = await loadRunManifest(root, runId);
    if (current.revision !== expectedRevision) {
      throw new ChangeForgeError(`Run manifest revision changed from ${expectedRevision} to ${current.revision}.`, "RUN_MANIFEST_CONFLICT");
    }
    const next = validateRunManifestV1(await update(current));
    const immutableChanged = JSON.stringify([next.input, next.resolved, next.config, next.plan])
      !== JSON.stringify([current.input, current.resolved, current.config, current.plan]);
    if (next.runId !== current.runId || next.createdAt !== current.createdAt || immutableChanged || next.revision !== current.revision + 1) {
      throw new ChangeForgeError("Run manifest updates must preserve identity and advance one revision.", "RUN_MANIFEST_INVALID");
    }
    return saveRunManifest(root, next);
  });
}

export async function withRunLock<T>(
  root: string,
  runId: string,
  operation: string,
  run: () => Promise<T>
): Promise<T> {
  assertRunId(runId);
  assertOperation(operation);
  const directory = path.join(root, ".changeforge", "locks", runId);
  try {
    await ensureDirContained(root, directory);
  } catch (error) {
    throw lockFailed(operation, error);
  }
  const file = path.join(directory, `${operation.toLowerCase()}.lock`);
  const owner: LockOwner = { pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
    try {
      handle = await openLock(file);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw lockFailed(operation, error);
      if (attempt || !(await recoverStaleLock(file))) {
        throw new ChangeForgeError(`Run operation ${operation} is already locked.`, "RUN_OPERATION_LOCKED");
      }
    }
  }
  if (!handle) throw new ChangeForgeError(`Run operation ${operation} is already locked.`, "RUN_OPERATION_LOCKED");
  try {
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
  } catch (error) {
    await releaseLock(file, handle).catch(() => undefined);
    throw lockFailed(operation, error);
  }
  try {
    return await run();
  } finally {
    await releaseLock(file, handle);
  }
}

export async function runHasActiveLocks(root: string, runId: string, exclude: string[] = []) {
  assertRunId(runId);
  const directory = path.join(root, ".changeforge", "locks", runId);
  if (!await existsContained(root, directory)) return false;
  try {
    await ensureDirContained(root, directory);
  } catch (error) {
    throw lockFailed("cleanup", error);
  }
  const ignored = new Set(exclude.map((name) => `${name.toLowerCase()}.lock`));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name) || !entry.name.endsWith(".lock")) continue;
    if (!entry.isFile() || await activeLock(path.join(directory, entry.name))) return true;
  }
  return false;
}

async function openLock(file: string) {
  return fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
}

async function recoverStaleLock(file: string) {
  const first = await readLock(file).catch(() => undefined);
  if (first === null) return true;
  if (!first) return false;
  if (first.owner) {
    if (pidAlive(first.owner.pid)) return false;
    const second = await readLock(file).catch(() => undefined);
    if (second === null) return true;
    if (!second?.owner || second.owner.token !== first.owner.token) return false;
    return unlinkLock(file);
  }
  if (Date.now() - first.mtimeMs < RUN_LOCK_MALFORMED_STALE_MS) return false;
  const second = await readLock(file).catch(() => undefined);
  if (second === null) return true;
  if (!second || second.owner || second.identity !== first.identity) return false;
  return unlinkLock(file);
}

async function activeLock(file: string) {
  const lock = await readLock(file).catch(() => undefined);
  if (lock === null) return false;
  if (!lock) return true;
  return !(await recoverStaleLock(file));
}

async function readLock(file: string) {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, constants.O_RDONLY | noFollow());
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    const source = stat.size <= 4096 ? await handle.readFile("utf8") : "";
    return {
      owner: parseLockOwner(source),
      mtimeMs: stat.mtimeMs,
      identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${source}`
    };
  } finally {
    await handle.close();
  }
}

function parseLockOwner(source: string): LockOwner | null {
  try {
    const value = JSON.parse(source) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "createdAt,pid,token") return null;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.createdAt !== "string" || new Date(value.createdAt).toISOString() !== value.createdAt) return null;
    if (typeof value.token !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(value.token)) return null;
    return { pid: Number(value.pid), createdAt: value.createdAt, token: value.token };
  } catch {
    return null;
  }
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function unlinkLock(file: string) {
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

async function releaseLock(file: string, handle: Awaited<ReturnType<typeof fs.open>>) {
  await handle.close().catch(() => undefined);
  try {
    await fs.unlink(file);
  } catch (error) {
    if (!isMissing(error)) throw new ChangeForgeError(`Cannot release run operation lock: ${message(error)}`, "RUN_OPERATION_LOCK_FAILED");
  }
}

function noFollow() {
  return constants.O_NOFOLLOW ?? 0;
}

function relativeArtifactPath(base: string, target: string) {
  const relative = path.relative(path.resolve(base), target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ChangeForgeError("Artifact path must stay inside the run directory.", "RUN_ARTIFACT_INVALID");
  }
  return relative.split(path.sep).join("/");
}

function validateArtifact(manifest: RunManifestV1, name: string, artifact: RunArtifactV1) {
  validateRunManifestV1({ ...manifest, artifacts: { ...manifest.artifacts, [name]: artifact } });
}

async function artifactBuffer(base: string, target: string) {
  try {
    return await readBufferContained(base, target);
  } catch (error) {
    throw new ChangeForgeError(`Cannot read run artifact: ${message(error)}`, "RUN_ARTIFACT_INVALID");
  }
}

function assertRunId(runId: string) {
  if (!portableName(runId, 160)) {
    throw new ChangeForgeError("Invalid run manifest: runId is invalid.", "RUN_MANIFEST_INVALID");
  }
}

function assertOperation(operation: string) {
  if (!portableName(operation, 80)) {
    throw new ChangeForgeError("Run operation lock name is invalid.", "RUN_OPERATION_LOCK_FAILED");
  }
}

function portableName(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || /[ .]$/.test(value)) return false;
  const stem = value.split(".", 1)[0]!.replace(/[ .]+$/g, "").toUpperCase();
  return !["__PROTO__", "CONSTRUCTOR", "PROTOTYPE"].includes(value.toUpperCase()) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function timestamp(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ChangeForgeError("Invalid run manifest: now must be a valid date.", "RUN_MANIFEST_INVALID");
  }
  return value.toISOString();
}

function hash(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestError(error: unknown) {
  if (error instanceof ChangeForgeError && ["RUN_MANIFEST_INVALID", "RUN_ARTIFACT_INVALID"].includes(error.code)) return error;
  return new ChangeForgeError(`Invalid run manifest: ${message(error)}`, "RUN_MANIFEST_INVALID");
}

function lockFailed(operation: string, error: unknown) {
  return new ChangeForgeError(`Cannot acquire run operation ${operation}: ${message(error)}`, "RUN_OPERATION_LOCK_FAILED");
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return hasCode(error, "ENOENT");
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
