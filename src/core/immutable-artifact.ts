import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ChangeForgeError } from "./errors.js";
import { validateRunManifestV1, type RunArtifactV1, type RunManifestV1 } from "./run-manifest.js";
import { runDir } from "./paths.js";
import { assertSafeWritePath, ensureDirContained, readBufferContained } from "../utils/fs.js";

export async function stageImmutableArtifact(
  root: string,
  manifest: RunManifestV1,
  name: string,
  sourcePath: string,
  now = new Date()
): Promise<RunManifestV1> {
  const valid = validateRunManifestV1(manifest);
  assertArtifactName(valid, name);
  const base = runDir(root, valid.runId);
  const source = path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : path.resolve(base, sourcePath);
  const bytes = await readSource(base, source);
  const sha256 = hash(bytes);
  const relative = `artifacts/immutable/${name}/${sha256}.blob`;
  const artifact: RunArtifactV1 = { path: relative, sha256, bytes: bytes.length };
  const candidate = validateRunManifestV1({
    ...valid,
    updatedAt: latest(valid.updatedAt, now),
    revision: valid.revision + 1,
    artifacts: { ...valid.artifacts, [name]: artifact }
  });
  await writeImmutable(base, path.join(base, ...relative.split("/")), bytes);
  return candidate;
}

async function writeImmutable(base: string, target: string, bytes: Buffer) {
  let parent: string;
  try {
    parent = await ensureParent(base, path.dirname(target));
    await assertSafeWritePath(base, target);
  } catch (error) {
    throw artifactError(`Cannot prepare immutable artifact: ${message(error)}`);
  }
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeWritePath(base, target);
    try {
      await fs.link(temp, target);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await readBufferContained(base, target);
      if (!existing.equals(bytes)) throw artifactError("Immutable artifact content conflicts with its digest path.");
    }
  } catch (error) {
    if (error instanceof ChangeForgeError && error.code === "RUN_ARTIFACT_INVALID") throw error;
    throw artifactError(`Cannot write immutable artifact: ${message(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function ensureParent(base: string, target: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await ensureDirContained(base, target);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  return ensureDirContained(base, target);
}

async function readSource(base: string, source: string) {
  try {
    return await readBufferContained(base, source);
  } catch (error) {
    throw artifactError(`Cannot read immutable artifact source: ${message(error)}`);
  }
}

function assertArtifactName(manifest: RunManifestV1, name: string) {
  const digest = "0".repeat(64);
  validateRunManifestV1({
    ...manifest,
    artifacts: { [name]: { path: `artifacts/immutable/${name}/${digest}.blob`, sha256: digest, bytes: 0 } }
  });
}

function latest(current: string, now: Date) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ChangeForgeError("Invalid run manifest: now must be a valid date.", "RUN_MANIFEST_INVALID");
  }
  const value = now.toISOString();
  return value < current ? current : value;
}

function hash(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function artifactError(message: string) {
  return new ChangeForgeError(message, "RUN_ARTIFACT_INVALID");
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
