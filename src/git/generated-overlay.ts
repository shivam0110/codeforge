import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ChangeForgeError } from "../core/errors.js";
import { readManifest, type ManifestEntry, type PatchBaseline } from "./patch.js";

export type GeneratedFingerprintV1 = {
  kind: "file" | "symlink";
  mode: number;
  sha256: string;
};

export const GENERATED_OVERLAY_SCHEMA_VERSION = "1.0" as const;

export type GeneratedPayloadV1 =
  | { kind: "file"; mode: number; data: string }
  | { kind: "symlink"; mode: number; linkText: string };

export interface GeneratedOverlayV1 {
  schemaVersion: typeof GENERATED_OVERLAY_SCHEMA_VERSION;
  entries: {
    path: string;
    before: GeneratedFingerprintV1 | null;
    after: GeneratedPayloadV1 | null;
  }[];
}

export async function captureGeneratedOverlay(
  root: string,
  baseline: PatchBaseline,
  allowedRelativePaths: string[]
): Promise<GeneratedOverlayV1> {
  if (path.resolve(root) !== path.resolve(baseline.root)) invalid("Baseline belongs to another root.");
  const allowed = validatePaths([...allowedRelativePaths].sort(comparePath));
  const final = await readManifest(root, baseline.excluded, baseline.ignored);
  return validateGeneratedOverlayV1({
    schemaVersion: GENERATED_OVERLAY_SCHEMA_VERSION,
    entries: allowed.flatMap((file) => {
      const before = baseline.entries.get(file);
      const after = final.get(file);
      return sameEntry(before, after) ? [] : [{ path: file, before: fingerprint(before), after: payload(after) }];
    })
  });
}

export function validateGeneratedOverlayV1(value: unknown): GeneratedOverlayV1 {
  try {
    const data = object(value, "overlay", ["schemaVersion", "entries"]);
    if (data.schemaVersion !== GENERATED_OVERLAY_SCHEMA_VERSION) invalid("Unsupported schemaVersion.");
    if (!Array.isArray(data.entries)) invalid("entries must be an array.");
    const paths = validatePaths(data.entries.map((item, index) => object(item, `entries[${index}]`, ["path", "before", "after"]).path));
    const entries = data.entries.map((item, index) => {
      const entry = object(item, `entries[${index}]`, ["path", "before", "after"]);
      const before = entry.before === null ? null : parseFingerprint(entry.before, index);
      const after = entry.after === null ? null : parsePayload(entry.after, index);
      if (!before && !after) invalid(`entries[${index}] has no state.`);
      if (sameFingerprint(before, fingerprintFromPayload(after))) invalid(`entries[${index}] is unchanged.`);
      return { path: paths[index], before, after };
    });
    return { schemaVersion: GENERATED_OVERLAY_SCHEMA_VERSION, entries };
  } catch (error) {
    if (error instanceof ChangeForgeError && error.code === "GENERATED_OVERLAY_INVALID") throw error;
    invalid(error instanceof Error ? error.message : String(error));
  }
}

export async function replayGeneratedOverlay(root: string, value: unknown) {
  const overlay = validateGeneratedOverlayV1(value);
  await Promise.all(overlay.entries.map(({ path: file }) => inspect(root, file)));
  for (const entry of overlay.entries) await writePayload(root, entry.path, entry.after);
}

export async function applyGeneratedOverlay(root: string, value: unknown): Promise<"applied" | "already-applied"> {
  const overlay = validateGeneratedOverlayV1(value);
  const state = await generatedOverlayState(root, overlay);
  if (state === "after") return "already-applied";
  for (const entry of overlay.entries) await writePayload(root, entry.path, entry.after);
  return "applied";
}

export async function generatedOverlayState(root: string, value: unknown): Promise<"before" | "after"> {
  const overlay = validateGeneratedOverlayV1(value);
  const current = await Promise.all(overlay.entries.map(({ path: file }) => inspect(root, file)));
  const states = overlay.entries.map((entry, index) => {
    const state = current[index];
    if (sameFingerprint(state, entry.before)) return "before";
    if (sameFingerprint(state, fingerprintFromPayload(entry.after))) return "after";
    return "conflict";
  });
  const distinct = new Set(states);
  if (distinct.has("conflict") || distinct.size > 1) conflict("Generated paths are mixed or have changed since inspection.");
  return states.length && distinct.has("before") ? "before" : "after";
}

function parseFingerprint(value: unknown, index: number): GeneratedFingerprintV1 {
  const data = object(value, `entries[${index}].before`, ["kind", "mode", "sha256"]);
  if (!["file", "symlink"].includes(String(data.kind))) invalid(`entries[${index}].before.kind is invalid.`);
  return {
    kind: data.kind as "file" | "symlink",
    mode: mode(data.mode, data.kind === "file" ? [0o100644, 0o100755] : [0o120000]),
    sha256: digestValue(data.sha256)
  };
}

function parsePayload(value: unknown, index: number): GeneratedPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`entries[${index}].after must be an object.`);
  const data = value as Record<string, unknown>;
  if (data.kind === "file") {
    exact(data, `entries[${index}].after`, ["kind", "mode", "data"]);
    const bytes = base64(data.data, `entries[${index}].after.data`);
    return { kind: "file", mode: mode(data.mode, [0o100644, 0o100755]), data: bytes.toString("base64") };
  }
  if (data.kind === "symlink") {
    exact(data, `entries[${index}].after`, ["kind", "mode", "linkText"]);
    return {
      kind: "symlink",
      mode: mode(data.mode, [0o120000]),
      linkText: text(data.linkText, `entries[${index}].after.linkText`)
    };
  }
  invalid(`entries[${index}].after.kind is invalid.`);
}

function validatePaths(values: unknown[]) {
  const paths = values.map((value, index) => safePath(value, `path[${index}]`));
  const seen: { path: string; identity: string }[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const file = paths[index];
    const identity = pathIdentity(file);
    if (seen.some((entry) => entry.identity === identity)) invalid(`Duplicate or case-colliding path: ${file}.`);
    if (index && comparePath(paths[index - 1], file) >= 0) invalid("Paths must be sorted.");
    if (seen.some((entry) => ancestor(entry.identity, identity) || ancestor(identity, entry.identity))) {
      invalid(`Paths overlap: ${file}.`);
    }
    seen.push({ path: file, identity });
  }
  return paths;
}

function safePath(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.normalize(value) !== value
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || hasControl(value)) invalid(`${label} is unsafe.`);
  const parts = value.split("/");
  if (parts.some((part) => !part || [".", "..", ".git", ".changeforge", ".changeforge-runtime", "node_modules"].includes(pathIdentity(part))
    || part.endsWith(".") || part.endsWith(" ") || /[<>:"|?*]/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) invalid(`${label} is reserved.`);
  return value;
}

async function inspect(root: string, file: string): Promise<GeneratedFingerprintV1 | null> {
  await safeParent(root, file, false);
  const target = path.join(path.resolve(root), ...file.split("/"));
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return {
    kind: "symlink",
    mode: 0o120000,
    sha256: hash(Buffer.from(await fs.readlink(target)))
  };
  if (!stat.isFile()) conflict(`Generated path is not a file: ${file}.`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isFile()) conflict(`Generated path changed during inspection: ${file}.`);
    return {
      kind: "file",
      mode: actual.mode & 0o111 ? 0o100755 : 0o100644,
      sha256: hash(await handle.readFile())
    };
  } catch (error) {
    if (error instanceof ChangeForgeError) throw error;
    return conflict(`Cannot safely inspect generated path: ${file}.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writePayload(root: string, file: string, after: GeneratedPayloadV1 | null) {
  const parent = await safeParent(root, file, true);
  const target = path.join(parent, path.basename(file));
  if (!after) {
    await fs.unlink(target).catch((error) => {
      if (!missing(error)) throw error;
    });
    return;
  }
  const temp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    if (after.kind === "file") {
      const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, after.mode & 0o777);
      try {
        await handle.writeFile(Buffer.from(after.data, "base64"));
        await handle.chmod(after.mode & 0o777);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await fs.symlink(after.linkText, temp);
    }
    await replace(temp, target);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function safeParent(root: string, file: string, create: boolean) {
  const base = path.resolve(root);
  const rootEntry = await fs.lstat(base).catch(() => null);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) conflict("Overlay root must be a real directory.");
  let current = base;
  for (const part of file.split("/").slice(0, -1)) {
    current = path.join(current, part);
    let entry = await fs.lstat(current).catch((error) => missing(error) ? null : Promise.reject(error));
    if (!entry && create) {
      await fs.mkdir(current);
      entry = await fs.lstat(current);
    }
    if (!entry) break;
    if (!entry.isDirectory() || entry.isSymbolicLink()) conflict(`Overlay path has an unsafe parent: ${file}.`);
  }
  return path.dirname(path.join(base, ...file.split("/")));
}

async function replace(source: string, target: string) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ["EEXIST", "EPERM"].includes(String(error.code)))) throw error;
    await fs.unlink(target);
    await fs.rename(source, target);
  }
}

function fingerprint(entry?: ManifestEntry): GeneratedFingerprintV1 | null {
  if (!entry) return null;
  const bytes = entry.kind === "file" ? entry.data : Buffer.from(entry.linkText);
  return { kind: entry.kind, mode: entry.mode, sha256: hash(bytes) };
}

function payload(entry?: ManifestEntry): GeneratedPayloadV1 | null {
  if (!entry) return null;
  return entry.kind === "file"
    ? { kind: "file", mode: entry.mode, data: entry.data.toString("base64") }
    : { kind: "symlink", mode: entry.mode, linkText: entry.linkText };
}

function fingerprintFromPayload(entry: GeneratedPayloadV1 | null) {
  if (!entry) return null;
  const bytes = entry.kind === "file" ? Buffer.from(entry.data, "base64") : Buffer.from(entry.linkText);
  return { kind: entry.kind, mode: entry.mode, sha256: hash(bytes) };
}

function sameEntry(left?: ManifestEntry, right?: ManifestEntry) {
  return sameFingerprint(fingerprint(left), fingerprint(right));
}

function sameFingerprint(left: GeneratedFingerprintV1 | null, right: GeneratedFingerprintV1 | null) {
  return !left || !right
    ? left === right
    : left.kind === right.kind && left.mode === right.mode && left.sha256 === right.sha256;
}

function object(value: unknown, label: string, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const data = value as Record<string, unknown>;
  exact(data, label, keys);
  return data;
}

function exact(data: Record<string, unknown>, label: string, keys: readonly string[]) {
  const actual = Object.keys(data);
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(data, key)) || actual.some((key) => !keys.includes(key))) {
    invalid(`${label} has invalid keys.`);
  }
}

function mode(value: unknown, values: number[]) {
  if (typeof value !== "number" || !values.includes(value)) invalid("Entry mode is invalid.");
  return value;
}

function base64(value: unknown, label: string) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalid(`${label} is not canonical base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) invalid(`${label} is not canonical base64.`);
  return bytes;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || hasControl(value)) invalid(`${label} contains control characters.`);
  return value;
}

function digestValue(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid("Fingerprint digest is invalid.");
  return value;
}

function hash(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function hasControl(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code >= 0x7f && code <= 0x9f;
  });
}

function pathIdentity(value: string) {
  return value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

function ancestor(parent: string, child: string) {
  return child.startsWith(`${parent}/`);
}

function comparePath(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function missing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code));
}

function invalid(message: string): never {
  throw new ChangeForgeError(`Invalid generated overlay: ${message}`, "GENERATED_OVERLAY_INVALID");
}

function conflict(message: string): never {
  throw new ChangeForgeError(message, "GENERATED_OVERLAY_CONFLICT");
}
