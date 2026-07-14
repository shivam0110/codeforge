import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import { ChangeForgeError } from "../core/errors.js";
import type { ChangeInput, DiffContext } from "../core/types.js";
import { ensureDirContained, writeTextContained } from "../utils/fs.js";
import { manifestPatch, type ManifestEntry } from "./patch.js";
import { isolatedGitEnv } from "./env.js";

type TreeEntry = ManifestEntry | { kind: "gitlink"; oid: string; mode: number; dirty?: boolean };
type OverlayEntry = TreeEntry | null;
type IndexEntry = {
  mode: number;
  oid: string;
  stat: { ctime: [bigint, bigint]; mtime: [bigint, bigint]; dev: bigint; ino: bigint; uid: bigint; gid: bigint; size: bigint };
};
type IndexSettings = {
  fileMode: boolean;
  symlinks: boolean;
  trustCtime: boolean;
  minimalStat: boolean;
  autoCrlf: boolean | "input";
  indexMtime: bigint;
};

export type ResolvedChangeSet = {
  root: string;
  input: ChangeInput;
  baseSha: string;
  headSha: string;
  symlinks: boolean;
  diff: DiffContext;
  tree: Map<string, TreeEntry>;
  overlay: Map<string, OverlayEntry>;
};

export const CHANGE_SNAPSHOT_SCHEMA_VERSION = "1.0" as const;

type SnapshotEntry =
  | { kind: "file"; data: string; mode: number; sha256: string }
  | { kind: "symlink"; linkText: string; mode: number }
  | { kind: "gitlink"; oid: string; mode: number; dirty?: boolean };

export interface ChangeSnapshotV1 {
  schemaVersion: typeof CHANGE_SNAPSHOT_SCHEMA_VERSION;
  input: ChangeInput;
  baseSha: string;
  headSha: string;
  symlinks: boolean;
  diff: DiffContext;
  overlay: { path: string; entry: SnapshotEntry | null }[];
}

export async function resolveChangeSet(root: string, input: ChangeInput): Promise<ResolvedChangeSet> {
  const [resolved, settings] = await Promise.all([resolveRefs(root, input), indexSettings(root)]);
  const tree = await readTree(root, resolved.headSha);
  assertNoReservedPaths(tree.keys());
  if (input.kind === "working-tree" || input.kind === "file") {
    const selected = input.kind === "file" ? safeRelative(input.value) : null;
    if (selected && !tree.has(selected) && !(await fs.lstat(targetPath(root, selected)).catch(() => null))) {
      throw new ChangeForgeError(
        `File not found relative to the repository root: ${selected}`,
        "GIT_FILE_NOT_FOUND",
        `Repository root: ${root}\nUse the full repository-relative path when running from a monorepo root.`
      );
    }
    const captured = await captureOverlay(root, tree, selected, settings);
    const { overlay } = captured;
    assertNoReservedPaths(overlay.keys());
    const changedFiles = [...overlay].map(([file, entry]) => ({
      status: !tree.has(file) ? "A" : entry === null ? "D" : "M",
      paths: [file]
    }));
    if (!changedFiles.length) emptyChange();
    const before = regularEntries(tree);
    const after = new Map(before);
    for (const [file, entry] of captured.semantic) {
      if (!entry || entry.kind === "gitlink") after.delete(file);
      else after.set(file, entry);
    }
    const patch = [await manifestPatch(before, after), gitlinkPatch(tree, captured.semantic)].filter(Boolean).join("\n");
    return {
      root, input, ...resolved, symlinks: settings.symlinks, tree, overlay,
      diff: makeDiff(input, patch, changedFiles, gitlinkChanges(tree, captured.semantic))
    };
  }

  const [patch, stat, names] = await Promise.all([
    gitText(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--find-renames", "--submodule=short",
      "--src-prefix=a/", "--dst-prefix=b/", resolved.baseSha, resolved.headSha]),
    gitText(root, ["diff", "--stat", "--no-ext-diff", "--no-textconv", "--find-renames", "--submodule=short",
      resolved.baseSha, resolved.headSha]),
    gitBytes(root, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", resolved.baseSha, resolved.headSha])
  ]);
  const changedFiles = parseNameStatus(names);
  if (!changedFiles.length) emptyChange();
  const gitlinks = await rangeGitlinks(root, resolved.baseSha, resolved.headSha, changedFiles);
  return {
    root, input, ...resolved, symlinks: settings.symlinks, tree, overlay: new Map(),
    diff: {
      input,
      patch,
      stat,
      nameStatus: changedFiles.map((item) => [item.status, ...item.paths].join("\t")).join("\n"),
      changedFiles,
      gitlinks
    }
  };
}

function assertNoReservedPaths(files: Iterable<string>) {
  for (const file of files) {
    if (reservedRepositoryPath(file)) {
      throw new ChangeForgeError(`Repository path ${file} is reserved by ChangeForge.`, "GIT_PATH_INVALID");
    }
  }
}

export async function materializeChangeSet(change: ResolvedChangeSet, workRoot: string) {
  await prepareMaterializationRoot(workRoot);
  for (const [file, entry] of change.tree) await materializeEntry(workRoot, file, entry, change.symlinks);
  const overlay = [...change.overlay].sort(([left], [right]) => pathDepth(left) - pathDepth(right) || comparePath(left, right));
  for (const [file] of overlay) {
    const target = targetPath(workRoot, file);
    await rejectSymlinkParents(workRoot, file);
    await fs.rm(target, { recursive: true, force: true });
  }
  for (const [file, entry] of overlay) if (entry) await materializeEntry(workRoot, file, entry, change.symlinks);
  return workRoot;
}

export async function materializeRevision(root: string, treeish: string, symlinks: boolean, workRoot: string) {
  const empty = await emptyTree(root);
  const tree = treeish === empty ? new Map<string, TreeEntry>() : await availableTree(root, treeish);
  assertNoReservedPaths(tree.keys());
  await prepareMaterializationRoot(workRoot);
  for (const [file, entry] of tree) await materializeEntry(workRoot, file, entry, symlinks);
  return workRoot;
}

export function snapshotChangeSet(change: ResolvedChangeSet): ChangeSnapshotV1 {
  return validateChangeSnapshotV1({
    schemaVersion: CHANGE_SNAPSHOT_SCHEMA_VERSION,
    input: change.input,
    baseSha: change.baseSha,
    headSha: change.headSha,
    symlinks: change.symlinks,
    diff: change.diff,
    overlay: [...change.overlay]
      .sort(([left], [right]) => comparePath(left, right))
      .map(([file, entry]) => ({ path: file, entry: snapshotEntry(entry) }))
  });
}

export function validateChangeSnapshotV1(value: unknown): ChangeSnapshotV1 {
  try {
    const data = strictObject(value, "snapshot", [
      "schemaVersion", "input", "baseSha", "headSha", "symlinks", "diff", "overlay"
    ]);
    if (data.schemaVersion !== CHANGE_SNAPSHOT_SCHEMA_VERSION) snapshotInvalid("Unsupported schemaVersion.");
    const input = snapshotInput(data.input);
    const baseSha = snapshotOid(data.baseSha, "baseSha");
    const headSha = snapshotOid(data.headSha, "headSha");
    if (baseSha.length !== headSha.length) snapshotInvalid("Object IDs use different hash formats.");
    if (typeof data.symlinks !== "boolean") snapshotInvalid("symlinks must be boolean.");
    const diff = snapshotDiff(data.diff);
    if (JSON.stringify(diff.input) !== JSON.stringify(input)) snapshotInvalid("diff input does not match input.");
    const overlay = snapshotOverlay(data.overlay, headSha.length);
    for (const link of diff.gitlinks ?? []) {
      if (link.oldSha !== undefined && link.oldSha.length !== headSha.length
        || link.newSha !== undefined && link.newSha.length !== headSha.length) {
        snapshotInvalid("Gitlink object IDs use a different hash format.");
      }
    }
    if (["working-tree", "file"].includes(input.kind)) {
      const changedPaths = diff.changedFiles.flatMap((item) => item.paths);
      const changed = new Set(changedPaths);
      const captured = new Set(overlay.map(({ path: file }) => file));
      if (changed.size !== changedPaths.length || changed.size !== captured.size
        || [...changed].some((file) => !captured.has(file))) snapshotInvalid("overlay does not match changed paths.");
    } else if (overlay.length) snapshotInvalid("Committed inputs cannot contain an overlay.");
    return { schemaVersion: CHANGE_SNAPSHOT_SCHEMA_VERSION, input, baseSha, headSha, symlinks: data.symlinks, diff, overlay };
  } catch (error) {
    if (error instanceof ChangeForgeError && error.code === "CHANGE_SNAPSHOT_INVALID") throw error;
    snapshotInvalid(error instanceof Error ? error.message : String(error));
  }
}

export async function restoreChangeSet(root: string, value: unknown): Promise<ResolvedChangeSet> {
  const snapshot = validateChangeSnapshotV1(value);
  const tree = await availableTree(root, snapshot.headSha, true);
  assertNoReservedPaths(tree.keys());
  assertOverlayTreeCompatibility(tree, snapshot.overlay);
  for (const { path: file, entry } of snapshot.overlay) {
    if (!entry && !tree.has(file) || entry && sameTreeEntry(tree.get(file), restoreEntry(entry))) {
      snapshotInvalid(`overlay entry ${file} does not change the captured tree.`);
    }
  }
  return {
    root,
    input: snapshot.input,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    symlinks: snapshot.symlinks,
    diff: snapshot.diff,
    tree,
    overlay: new Map(snapshot.overlay.map(({ path: file, entry }) => [file, restoreEntry(entry)]))
  };
}

function assertOverlayTreeCompatibility(
  tree: Map<string, TreeEntry>,
  overlay: ChangeSnapshotV1["overlay"]
) {
  const treeByIdentity = new Map<string, string[]>();
  for (const file of tree.keys()) {
    const identity = pathIdentity(file);
    treeByIdentity.set(identity, [...treeByIdentity.get(identity) ?? [], file]);
  }
  const captured = new Map(overlay.map((item) => [item.path, item.entry]));
  for (const item of overlay) {
    if (!item.entry) continue;
    const parts = item.path.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const ancestors = treeByIdentity.get(pathIdentity(parts.slice(0, length).join("/"))) ?? [];
      if (ancestors.some((file) => !captured.has(file) || captured.get(file) !== null)) {
        snapshotInvalid(`overlay entry ${item.path} requires an explicit ancestor deletion.`);
      }
    }
  }
}

async function prepareMaterializationRoot(workRoot: string) {
  await fs.mkdir(workRoot, { recursive: true });
  const rootEntry = await fs.lstat(workRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new ChangeForgeError("Sandbox root must be a real directory.", "PATH_SYMLINK");
  }
  if ((await fs.readdir(workRoot)).length) {
    throw new ChangeForgeError("Sandbox root must be empty.", "PATH_NOT_EMPTY");
  }
}

async function resolveRefs(root: string, input: ChangeInput) {
  if (input.kind === "working-tree" || input.kind === "file") {
    const headSha = await commit(root, "HEAD");
    return { baseSha: headSha, headSha };
  }
  if (input.kind === "commit") {
    const headSha = await commit(root, input.value);
    const parent = await firstParent(root, headSha);
    return { baseSha: parent ?? await emptyTree(root), headSha };
  }
  const match = input.value.match(/^(.*?)\s*(\.\.\.?)(.*?)$/);
  if (!match?.[1] || !match[3]) invalidRef(input.value);
  const left = await commit(root, match[1]);
  const headSha = await commit(root, match[3]);
  const baseSha = match[2] === "..." ? (await requiredText(root, ["merge-base", left, headSha], "GIT_REF_INVALID")).trim() : left;
  return { baseSha, headSha };
}

async function readTree(root: string, sha: string) {
  const raw = await gitText(root, ["ls-tree", "-rz", "--full-tree", sha]);
  const rows = raw.split("\0").filter(Boolean).map((record) => {
    const match = record.match(/^([0-7]+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/);
    if (!match) throw new ChangeForgeError("Cannot parse Git tree output.", "GIT_TREE_INVALID");
    return { mode: Number.parseInt(match[1], 8), type: match[2], oid: match[3], file: match[4] };
  });
  const blobs = await readBlobs(root, [...new Set(rows.filter((row) => row.type === "blob").map((row) => row.oid))]);
  const tree = new Map<string, TreeEntry>();
  for (const row of rows) {
    if (row.type === "commit") tree.set(row.file, { kind: "gitlink", oid: row.oid, mode: row.mode });
    else if (row.mode === 0o120000) tree.set(row.file, { kind: "symlink", linkText: blobs.get(row.oid)!.toString(), mode: row.mode });
    else tree.set(row.file, { kind: "file", data: blobs.get(row.oid)!, mode: row.mode });
  }
  return tree;
}

async function captureOverlay(root: string, tree: Map<string, TreeEntry>, only: string | null, settings: IndexSettings) {
  const [untrackedRaw, indexRaw] = await Promise.all([
    gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    gitBytes(root, ["ls-files", "--stage", "--debug", "-z"])
  ]);
  const untracked = nulStrings(untrackedRaw);
  const index = parseIndex(indexRaw);
  const replacements = await replacementPaths(root, tree);
  const candidates = unique([
    ...tree.keys(),
    ...index.keys(),
    ...untracked,
    ...replacements,
    ...(only ? [only] : [])
  ]).filter((file) => only === null || file === only || only.startsWith(`${file}/`));
  const sparseExcluded = await sparseExcludedPaths(root, candidates);
  const overlay = new Map<string, OverlayEntry>();
  const semantic = new Map<string, OverlayEntry>();
  for (const file of candidates) {
    const indexed = index.get(file);
    let current: OverlayEntry;
    let compared: OverlayEntry;
    if (await hasNonDirectoryParent(root, file)) {
      current = compared = null;
    } else if (indexed?.mode === 0o160000) {
      current = compared = await captureGitlink(root, file, indexed, sparseExcluded.has(file), settings);
    } else if (indexed && await matchesIndexStat(root, file, indexed, settings)) {
      compared = await indexEntry(root, indexed);
      current = sameTreeEntry(tree.get(file), compared)
        ? compared
        : await capturePath(root, file, indexed, settings);
    } else {
      current = await capturePath(root, file, indexed, settings);
      if (current === null && indexed && sparseExcluded.has(file)) current = await indexEntry(root, indexed);
      compared = await semanticEntry(root, file, current, indexed, settings);
    }
    if (!sameTreeEntry(tree.get(file), compared)) {
      overlay.set(file, current);
      semantic.set(file, compared);
    }
  }
  return { overlay, semantic };
}

async function replacementPaths(root: string, tree: Map<string, TreeEntry>) {
  const found = new Set<string>();
  for (const [file, expected] of tree) {
    const parts = file.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const ancestor = parts.slice(0, length).join("/");
      const entry = await fs.lstat(targetPath(root, ancestor)).catch(() => null);
      if (entry && !entry.isDirectory()) {
        found.add(ancestor);
        break;
      }
    }
    const current = await fs.lstat(targetPath(root, file)).catch(() => null);
    const realSubmodule = expected.kind === "gitlink" && current?.isDirectory()
      && Boolean(await fs.lstat(path.join(targetPath(root, file), ".git")).catch(() => null));
    if (current?.isDirectory() && !realSubmodule) {
      for (const child of await filesUnder(root, file)) found.add(child);
    }
  }
  return [...found];
}

async function filesUnder(root: string, relative: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(targetPath(root, relative), { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await filesUnder(root, child));
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(child);
  }
  return found;
}

async function hasNonDirectoryParent(root: string, file: string) {
  const parts = file.split("/");
  for (let length = 1; length < parts.length; length += 1) {
    const ancestor = parts.slice(0, length).join("/");
    const entry = await fs.lstat(targetPath(root, ancestor)).catch(() => null);
    if (entry && !entry.isDirectory()) return true;
  }
  return false;
}

async function captureGitlink(
  root: string,
  file: string,
  indexed: { mode: number; oid: string },
  sparseExcluded: boolean,
  settings: IndexSettings
): Promise<OverlayEntry> {
  const target = targetPath(root, file);
  const entry = await fs.lstat(target).catch(() => null);
  if (entry && !entry.isDirectory()) return capturePath(root, file, undefined, settings);
  if (!entry && sparseExcluded) return { kind: "gitlink", oid: indexed.oid, mode: indexed.mode };
  if (!entry && !(await knownSubmodule(root, file))) return { kind: "gitlink", oid: indexed.oid, mode: indexed.mode };
  const workOid = await submoduleHead(root, file);
  if (workOid) return {
    kind: "gitlink",
    oid: workOid,
    mode: indexed.mode,
    dirty: await submoduleDirty(target, workOid)
  };
  if (entry?.isDirectory()) {
    const empty = (await fs.readdir(target)).length === 0;
    if (!empty || !(await submoduleStorageExists(root, file))) return null;
  }
  const diff = await gitResult(root, ["diff-files", "--quiet", "--no-ext-diff", "--ignore-submodules=none", "--", file]);
  if (diff.exitCode === 0) return { kind: "gitlink", oid: indexed.oid, mode: indexed.mode };
  if (diff.exitCode === 1) return null;
  throw new ChangeForgeError(diff.stderr.toString() || `Cannot inspect submodule ${file}.`, "GIT_COMMAND_FAILED");
}

async function submoduleStorageExists(root: string, file: string) {
  const result = await gitResult(root, ["rev-parse", "--git-path", `modules/${file}`]);
  return result.exitCode === 0
    && Boolean(await fs.lstat(path.resolve(root, result.stdout.toString().trim())).catch(() => null));
}

async function submoduleDirty(root: string, head: string) {
  const tree = await readTree(root, head);
  return (await captureOverlay(root, tree, null, await indexSettings(root))).overlay.size > 0;
}

async function knownSubmodule(root: string, file: string) {
  const result = await gitResult(root, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
  if (result.exitCode !== 0) return false;
  return result.stdout.toString().split(/\r?\n/).some((line) => line.slice(line.search(/\s/) + 1).trim() === file);
}

async function sparseExcludedPaths(root: string, candidates: string[]) {
  const enabled = await gitResult(root, ["config", "--bool", "core.sparseCheckout"]);
  if (enabled.exitCode !== 0 || enabled.stdout.toString().trim() !== "true") return new Set<string>();
  const result = await gitResult(root, ["sparse-checkout", "check-rules", "-z"], Buffer.from(`${candidates.join("\0")}\0`));
  if (result.exitCode !== 0) {
    const tagged = nulStrings(await gitBytes(root, ["ls-files", "-t", "-z"]));
    return new Set(tagged.filter((item) => item.startsWith("S ")).map((item) => item.slice(2)));
  }
  const included = new Set(nulStrings(result.stdout));
  return new Set(candidates.filter((file) => !included.has(file)));
}

async function indexSettings(root: string): Promise<IndexSettings> {
  const [fileMode, symlinks, trustCtime, checkStat, autoCrlf, indexMtime] = await Promise.all([
    configValue(root, "core.filemode", true),
    configValue(root, "core.symlinks", true),
    configValue(root, "core.trustctime", true),
    configValue(root, "core.checkstat"),
    configValue(root, "core.autocrlf"),
    indexTimestamp(root)
  ]);
  return {
    fileMode: fileMode === true,
    symlinks: symlinks === true,
    trustCtime: trustCtime === true,
    minimalStat: typeof checkStat === "string" && checkStat.toLowerCase() === "minimal",
    autoCrlf: typeof autoCrlf === "string" && autoCrlf.toLowerCase() === "input"
      ? "input"
      : typeof autoCrlf === "string" && ["true", "yes", "on", "1"].includes(autoCrlf.toLowerCase()),
    indexMtime
  };
}

async function indexTimestamp(root: string) {
  const file = (await gitBytes(root, ["rev-parse", "--git-path", "index"])).toString().trim();
  const stat = await fs.stat(path.resolve(root, file), { bigint: true }).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  return stat ? u32(stat.mtimeNs / 1_000_000_000n) : 0n;
}

async function configValue(root: string, key: string): Promise<string | null>;
async function configValue(root: string, key: string, fallback: boolean): Promise<boolean>;
async function configValue(root: string, key: string, fallback?: boolean) {
  const args = ["config", ...(fallback === undefined ? [] : ["--bool"]), "--get", key];
  const result = await gitResult(root, args);
  if (result.exitCode === 1) return fallback ?? null;
  if (result.exitCode !== 0) {
    throw new ChangeForgeError(result.stderr.toString() || `Cannot read Git config ${key}.`, "GIT_CONFIG_INVALID");
  }
  const value = result.stdout.toString().trim();
  return fallback === undefined ? value : value === "true";
}

async function matchesIndexStat(root: string, file: string, indexed: IndexEntry, settings: IndexSettings) {
  const target = targetPath(root, file);
  await rejectSymlinkParents(root, file);
  let stat: BigIntStats;
  try {
    stat = await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
  const symlink = indexed.mode === 0o120000;
  if (!(symlink ? stat.isSymbolicLink() || (!settings.symlinks && stat.isFile()) : stat.isFile())) return false;
  if (!symlink && settings.fileMode && Boolean(indexed.mode & 0o111) !== Boolean(stat.mode & 0o111n)) return false;
  const seconds = 1_000_000_000n;
  const mtime: [bigint, bigint] = [u32(stat.mtimeNs / seconds), u32(stat.mtimeNs % seconds)];
  const ctime: [bigint, bigint] = [u32(stat.ctimeNs / seconds), u32(stat.ctimeNs % seconds)];
  if (indexed.stat.mtime[0] !== mtime[0] || indexed.stat.size !== u32(stat.size)) return false;
  if (settings.trustCtime && indexed.stat.ctime[0] !== ctime[0]) return false;
  const racy = indexed.stat.mtime[0] >= settings.indexMtime;
  if (racy && (settings.minimalStat || !settings.trustCtime || indexed.stat.mtime[1] === 0n || indexed.stat.ctime[1] === 0n)) {
    return false;
  }
  if (settings.minimalStat) return true;
  if (indexed.stat.mtime[1] !== mtime[1] || settings.trustCtime && indexed.stat.ctime[1] !== ctime[1]) return false;
  return indexed.stat.dev === u32(stat.dev) && indexed.stat.ino === u32(stat.ino)
    && indexed.stat.uid === u32(stat.uid) && indexed.stat.gid === u32(stat.gid);
}

function u32(value: bigint) {
  return BigInt.asUintN(32, value);
}

async function semanticEntry(
  root: string,
  file: string,
  current: OverlayEntry,
  indexed: IndexEntry | undefined,
  settings: IndexSettings
): Promise<OverlayEntry> {
  if (!current || current.kind !== "file" || !indexed || indexed.mode === 0o120000 || !current.data.includes("\r\n")) {
    return current;
  }
  const raw = await gitBytes(root, ["ls-files", "--eol", "-z", "--", file], undefined, { GIT_LITERAL_PATHSPECS: "1" });
  const record = nulStrings(raw)[0];
  const separator = record?.indexOf("\t") ?? -1;
  const match = separator >= 0 && record?.slice(separator + 1) === file
    ? record.slice(0, separator).match(/^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*)$/)
    : null;
  if (!match || match[1] === "-text" || match[2] === "-text") return current;
  const attributes = match[3].trim();
  const normalized = !/(^|\s)-text(?:\s|$)/.test(attributes)
    && (settings.autoCrlf !== false || /(^|\s)(?:text(?:=\S+)?|eol=(?:lf|crlf))(?:\s|$)/.test(attributes));
  if (!normalized) return current;
  const filter = await attributeValue(root, file, "filter");
  if (filter !== "unspecified" && filter !== "unset") {
    throw new ChangeForgeError(`Cannot safely capture normalized file with a clean filter: ${file}.`, "GIT_FILTER_UNSUPPORTED");
  }
  return {
    ...current,
    data: Buffer.from(current.data.toString("latin1").replaceAll("\r\n", "\n"), "latin1")
  };
}

async function attributeValue(root: string, file: string, attribute: string) {
  const raw = await gitBytes(root, ["check-attr", "-z", "--stdin", attribute], Buffer.from(`${file}\0`));
  const values = nulStrings(raw);
  if (values.length !== 3 || values[0] !== file || values[1] !== attribute) {
    throw new ChangeForgeError(`Cannot inspect Git attributes for ${file}.`, "GIT_ATTRIBUTE_INVALID");
  }
  return values[2];
}

async function indexEntry(root: string, entry: { mode: number; oid: string }): Promise<TreeEntry> {
  if (entry.mode === 0o160000) return { kind: "gitlink", ...entry };
  const data = (await readBlobs(root, [entry.oid])).get(entry.oid)!;
  return entry.mode === 0o120000
    ? { kind: "symlink", linkText: data.toString(), mode: entry.mode }
    : { kind: "file", data, mode: entry.mode };
}

async function submoduleHead(root: string, file: string) {
  const target = targetPath(root, file);
  if (!(await fs.lstat(target).catch(() => null))?.isDirectory()) return null;
  const marker = await fs.lstat(path.join(target, ".git")).catch(() => null);
  if (!marker || marker.isSymbolicLink()) return null;
  const env = { GIT_CEILING_DIRECTORIES: target };
  const [gitDir, head] = await Promise.all([
    gitResult(root, ["-C", file, "rev-parse", "--absolute-git-dir"], undefined, env),
    gitResult(root, ["-C", file, "rev-parse", "--verify", "HEAD^{commit}"], undefined, env)
  ]);
  if (gitDir.exitCode !== 0 || head.exitCode !== 0) return null;
  const actualGitDir = await fs.realpath(gitDir.stdout.toString().trim()).catch(() => "");
  const expected = await gitResult(root, ["rev-parse", "--git-path", `modules/${file}`]);
  const expectedGitDir = expected.exitCode === 0
    ? await fs.realpath(path.resolve(root, expected.stdout.toString().trim())).catch(() => "")
    : "";
  const relativeGitDir = path.relative(target, actualGitDir);
  const insideTarget = actualGitDir && relativeGitDir !== ".."
    && !relativeGitDir.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeGitDir);
  if (!insideTarget && actualGitDir !== expectedGitDir) return null;
  return head.stdout.toString().trim();
}

async function capturePath(
  root: string,
  file: string,
  indexed: IndexEntry | undefined,
  settings: IndexSettings
): Promise<OverlayEntry> {
  const target = targetPath(root, file);
  await rejectSymlinkParents(root, file);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: "symlink", linkText: await fs.readlink(target), mode: 0o120000 };
  if (!stat.isFile()) return null;
  const data = await fs.readFile(target);
  if (indexed?.mode === 0o120000 && !settings.symlinks) {
    return { kind: "symlink", linkText: data.toString(), mode: indexed.mode };
  }
  const mode = indexed && !settings.fileMode && indexed.mode !== 0o120000
    ? indexed.mode
    : stat.mode & 0o111 ? 0o100755 : 0o100644;
  return { kind: "file", data, mode };
}

async function rejectSymlinkParents(root: string, file: string) {
  let current = path.resolve(root);
  for (const part of file.split("/").slice(0, -1)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new ChangeForgeError(`File path crosses a symlink: ${file}`, "GIT_PATH_INVALID");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return;
    }
  }
}

async function materializeEntry(root: string, file: string, entry: TreeEntry, symlinks: boolean) {
  if (entry.kind === "gitlink") return;
  const target = targetPath(root, file);
  await ensureDirContained(root, path.dirname(target));
  if (entry.kind === "symlink") {
    if (symlinks) await fs.symlink(entry.linkText, target);
    else {
      await writeTextContained(root, target, entry.linkText);
      await fs.chmod(target, 0o644);
    }
    return;
  }
  await writeTextContained(root, target, entry.data);
  await fs.chmod(target, entry.mode & 0o777);
}

async function readBlobs(root: string, oids: string[]) {
  const out = new Map<string, Buffer>();
  if (!oids.length) return out;
  const raw = await gitBytes(root, ["cat-file", "--batch"], Buffer.from(`${oids.join("\n")}\n`));
  let offset = 0;
  for (const requested of oids) {
    const newline = raw.indexOf(10, offset);
    if (newline < 0) throw new ChangeForgeError("Invalid git cat-file response.", "GIT_OBJECT_INVALID");
    const header = raw.subarray(offset, newline).toString();
    const match = header.match(/^([0-9a-f]+) blob (\d+)$/);
    if (!match) throw new ChangeForgeError(`Cannot read Git object ${requested}.`, "GIT_OBJECT_INVALID");
    const size = Number(match[2]);
    const start = newline + 1;
    out.set(requested, Buffer.from(raw.subarray(start, start + size)));
    offset = start + size + 1;
  }
  return out;
}

async function commit(root: string, ref: string) {
  const result = await gitResult(root, ["rev-parse", "--verify", "--end-of-options", ref]);
  if (result.exitCode !== 0) invalidRef(ref);
  const value = result.stdout.toString().trim();
  const type = await gitObjectType(root, value);
  if (type === "commit") return value;
  if (type === "tag") {
    const peeled = await gitResult(root, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`]);
    if (peeled.exitCode === 0) return peeled.stdout.toString().trim();
  }
  invalidRef(ref);
}

async function firstParent(root: string, sha: string) {
  const object = await gitText(root, ["cat-file", "commit", sha]);
  const headers = object.split(/\r?\n\r?\n/, 1)[0];
  const line = headers.split(/\r?\n/).find((header) => header.startsWith("parent "));
  if (!line) return null;
  const parent = line.slice(7).trim();
  if (parent.length !== sha.length || !/^[0-9a-f]+$/.test(parent)) {
    throw new ChangeForgeError(`Commit ${sha} has an invalid parent.`, "GIT_OBJECT_INVALID");
  }
  const type = await gitObjectType(root, parent);
  if (type === "commit") return parent;
  if (type !== null) {
    throw new ChangeForgeError(`Commit ${sha} references a ${type} instead of a parent commit.`, "GIT_OBJECT_INVALID");
  }
  throw new ChangeForgeError(
    `Commit ${sha} references parent ${parent}, but that history is unavailable.`,
    "GIT_HISTORY_SHALLOW",
    "Fetch the missing history with `git fetch --unshallow` or `git fetch --deepen=50`, then retry."
  );
}

async function gitObjectType(root: string, oid: string) {
  const result = await gitResult(root, ["cat-file", "--batch-check=%(objecttype)"], Buffer.from(`${oid}\n`));
  if (result.exitCode !== 0) {
    throw new ChangeForgeError(result.stderr.toString() || `Cannot inspect Git object ${oid}.`, "GIT_COMMAND_FAILED");
  }
  const output = result.stdout.toString().trim();
  if (output === `${oid} missing`) return null;
  if (["blob", "commit", "tag", "tree"].includes(output)) return output;
  throw new ChangeForgeError(`Cannot classify Git object ${oid}.`, "GIT_OBJECT_INVALID");
}

async function emptyTree(root: string) {
  return (await gitBytes(root, ["hash-object", "-t", "tree", "--stdin"], Buffer.alloc(0))).toString().trim();
}

async function gitText(root: string, args: string[]) {
  return (await gitBytes(root, args)).toString();
}

async function requiredText(root: string, args: string[], code: string) {
  const result = await gitResult(root, args);
  if (result.exitCode !== 0) throw new ChangeForgeError(result.stderr.toString() || `Git command failed: ${args[0]}`, code);
  return result.stdout.toString();
}

async function gitBytes(root: string, args: string[], input?: Buffer, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = await gitResult(root, args, input, extraEnv);
  if (result.exitCode !== 0) throw new ChangeForgeError(result.stderr.toString() || `Git command failed: ${args[0]}`, "GIT_COMMAND_FAILED");
  return Buffer.from(result.stdout);
}

async function gitResult(root: string, args: string[], input?: Buffer, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = await execa("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    input,
    encoding: "buffer",
    reject: false,
    timeout: 120000,
    env: isolatedGitEnv(extraEnv),
    extendEnv: false
  });
  return { ...result, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) };
}

function parseNameStatus(raw: Buffer) {
  const tokens = nulStrings(raw);
  const out: { status: string; paths: string[] }[] = [];
  for (let index = 0; index < tokens.length;) {
    const first = tokens[index++];
    const tab = first.indexOf("\t");
    const status = tab < 0 ? first : first.slice(0, tab);
    const paths = tab < 0 ? [] : [first.slice(tab + 1)];
    const count = /^[RC]/.test(status) ? 2 : 1;
    while (paths.length < count && index < tokens.length) paths.push(tokens[index++]);
    out.push({ status, paths });
  }
  return out;
}

function parseIndex(raw: Buffer) {
  const out = new Map<string, IndexEntry>();
  const text = raw.toString();
  let offset = 0;
  while (offset < text.length) {
    const nul = text.indexOf("\0", offset);
    if (nul < 0) invalidIndex();
    const record = text.slice(offset, nul);
    const match = record.match(/^([0-7]+) ([0-9a-f]+) (\d+)\t([\s\S]+)$/);
    if (!match) invalidIndex();
    if (match[3] !== "0") {
      throw new ChangeForgeError(`Unresolved Git conflict: ${match[4]}.`, "GIT_CONFLICT_UNSUPPORTED");
    }
    const debug = text.slice(nul + 1).match(
      /^ {2}ctime: (\d+):(\d+)\r?\n {2}mtime: (\d+):(\d+)\r?\n {2}dev: (\d+)\tino: (\d+)\r?\n {2}uid: (\d+)\tgid: (\d+)\r?\n {2}size: (\d+)\tflags: [^\r\n]*(?:\r?\n|$)/
    );
    if (!debug) invalidIndex();
    out.set(match[4], {
      mode: Number.parseInt(match[1], 8),
      oid: match[2],
      stat: {
        ctime: [BigInt(debug[1]), BigInt(debug[2])],
        mtime: [BigInt(debug[3]), BigInt(debug[4])],
        dev: BigInt(debug[5]),
        ino: BigInt(debug[6]),
        uid: BigInt(debug[7]),
        gid: BigInt(debug[8]),
        size: BigInt(debug[9])
      }
    });
    offset = nul + 1 + debug[0].length;
  }
  return out;
}

function invalidIndex(): never {
  throw new ChangeForgeError("Cannot parse Git index metadata.", "GIT_INDEX_INVALID");
}

function regularEntries(tree: Map<string, TreeEntry>) {
  return new Map([...tree].filter((entry): entry is [string, ManifestEntry] => entry[1].kind !== "gitlink"));
}

function gitlinkPatch(tree: Map<string, TreeEntry>, overlay: Map<string, OverlayEntry>) {
  const parts: string[] = [];
  for (const [file, current] of overlay) {
    const previous = tree.get(file);
    if (previous?.kind !== "gitlink" && current?.kind !== "gitlink") continue;
    const oldOid = previous?.kind === "gitlink" ? previous.oid : null;
    const newOid = current?.kind === "gitlink" ? current.oid : null;
    const lines = [`diff --git ${gitPath(`a/${file}`)} ${gitPath(`b/${file}`)}`];
    if (!oldOid) lines.push("new file mode 160000");
    else if (!newOid) lines.push("deleted file mode 160000");
    if (oldOid && newOid) lines.push(`index ${oldOid.slice(0, 12)}..${newOid.slice(0, 12)} 160000`);
    lines.push(oldOid ? `--- ${gitPath(`a/${file}`)}` : "--- /dev/null", newOid ? `+++ ${gitPath(`b/${file}`)}` : "+++ /dev/null", "@@ -1 +1 @@");
    if (oldOid) lines.push(`-Subproject commit ${oldOid}`);
    if (newOid) lines.push(`+Subproject commit ${newOid}${current?.kind === "gitlink" && current.dirty ? "-dirty" : ""}`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n");
}

function gitPath(value: string) {
  const quoted = value.includes('"') || value.includes("\\")
    || [...value].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f);
  return quoted ? JSON.stringify(value) : value;
}

function gitlinkChanges(tree: Map<string, TreeEntry>, overlay: Map<string, OverlayEntry>) {
  const links: NonNullable<DiffContext["gitlinks"]> = [];
  for (const [file, current] of overlay) {
    const previous = tree.get(file);
    if (previous?.kind !== "gitlink" && current?.kind !== "gitlink") continue;
    links.push({
      path: file,
      oldSha: previous?.kind === "gitlink" ? previous.oid : undefined,
      newSha: current?.kind === "gitlink" ? current.oid : undefined,
      dirty: current?.kind === "gitlink" && current.dirty
    });
  }
  return links;
}

async function rangeGitlinks(
  root: string,
  base: string,
  head: string,
  changed: { status: string; paths: string[] }[]
) {
  const paths = unique(changed.flatMap((item) => item.paths));
  const [before, after] = await Promise.all([gitlinkEntries(root, base, paths), gitlinkEntries(root, head, paths)]);
  return changed.flatMap((item) => {
    const oldSha = before.get(item.paths[0]);
    const currentPath = item.paths.at(-1)!;
    const newSha = after.get(currentPath);
    return oldSha || newSha ? [{ path: currentPath, oldSha, newSha }] : [];
  });
}

async function gitlinkEntries(root: string, sha: string, paths: string[]) {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const wanted = new Set(paths);
  const raw = await gitText(root, ["ls-tree", "-rz", "--full-tree", sha]);
  for (const record of raw.split("\0").filter(Boolean)) {
    const match = record.match(/^160000 commit ([0-9a-f]+)\t([\s\S]+)$/);
    if (match && wanted.has(match[2])) out.set(match[2], match[1]);
  }
  return out;
}

function sameTreeEntry(left?: TreeEntry, right?: OverlayEntry) {
  if (!left || !right || left.kind !== right.kind || left.mode !== right.mode) return !left && !right;
  if (left.kind === "file" && right.kind === "file") return left.data.equals(right.data);
  if (left.kind === "symlink" && right.kind === "symlink") return left.linkText === right.linkText;
  return left.kind === "gitlink" && right.kind === "gitlink" && left.oid === right.oid && !right.dirty;
}

function makeDiff(
  input: ChangeInput,
  patch: string,
  changedFiles: { status: string; paths: string[] }[],
  gitlinks: NonNullable<DiffContext["gitlinks"]> = []
): DiffContext {
  return {
    input,
    patch,
    stat: `${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed`,
    nameStatus: changedFiles.map((item) => [item.status, ...item.paths].join("\t")).join("\n"),
    changedFiles,
    gitlinks
  };
}

function snapshotEntry(entry: OverlayEntry): SnapshotEntry | null {
  if (!entry) return null;
  if (entry.kind === "file") return {
    kind: "file",
    data: entry.data.toString("base64"),
    mode: entry.mode,
    sha256: digest(entry.data)
  };
  if (entry.kind === "symlink") return { kind: "symlink", linkText: entry.linkText, mode: entry.mode };
  return { kind: "gitlink", oid: entry.oid, mode: entry.mode, ...(entry.dirty ? { dirty: true } : {}) };
}

function restoreEntry(entry: SnapshotEntry | null): OverlayEntry {
  if (!entry) return null;
  if (entry.kind === "file") return { kind: "file", data: Buffer.from(entry.data, "base64"), mode: entry.mode };
  return { ...entry };
}

function snapshotOverlay(value: unknown, oidLength: number) {
  if (!Array.isArray(value)) snapshotInvalid("overlay must be an array.");
  let previous: string | null = null;
  const overlay = value.map((item, index) => {
    const data = strictObject(item, `overlay[${index}]`, ["path", "entry"]);
    const file = snapshotPath(data.path, `overlay[${index}].path`);
    if (previous !== null && comparePath(previous, file) >= 0) snapshotInvalid("overlay paths must be sorted.");
    previous = file;
    return { path: file, entry: data.entry === null ? null : snapshotOverlayEntry(data.entry, index, oidLength) };
  });
  const seen: { identity: string; entry: SnapshotEntry | null }[] = [];
  for (const item of overlay) {
    const identity = pathIdentity(item.path);
    if (seen.some((entry) => entry.identity === identity)) snapshotInvalid(`Duplicate overlay path: ${item.path}.`);
    if (item.entry && seen.some((entry) => entry.entry
      && (ancestor(entry.identity, identity) || ancestor(identity, entry.identity)))) {
      snapshotInvalid(`Overlay has incompatible parent and descendant states: ${item.path}.`);
    }
    seen.push({ identity, entry: item.entry });
  }
  return overlay;
}

function snapshotOverlayEntry(value: unknown, index: number, oidLength: number): SnapshotEntry {
  const base = strictObject(value, `overlay[${index}].entry`, ["kind"], ["data", "mode", "sha256", "linkText", "oid", "dirty"]);
  if (base.kind === "file") {
    exactKeys(base, `overlay[${index}].entry`, ["kind", "data", "mode", "sha256"]);
    const data = canonicalBase64(base.data, `overlay[${index}].entry.data`);
    const sha256 = snapshotDigest(base.sha256, `overlay[${index}].entry.sha256`);
    if (digest(data) !== sha256) snapshotInvalid(`overlay[${index}] digest does not match its data.`);
    return { kind: "file", data: data.toString("base64"), mode: snapshotMode(base.mode, [0o100644, 0o100755]), sha256 };
  }
  if (base.kind === "symlink") {
    exactKeys(base, `overlay[${index}].entry`, ["kind", "linkText", "mode"]);
    return {
      kind: "symlink",
      linkText: safeText(base.linkText, `overlay[${index}].entry.linkText`),
      mode: snapshotMode(base.mode, [0o120000])
    };
  }
  if (base.kind === "gitlink") {
    exactKeys(base, `overlay[${index}].entry`, ["kind", "oid", "mode"], ["dirty"]);
    const oid = snapshotOid(base.oid, `overlay[${index}].entry.oid`);
    if (oid.length !== oidLength) snapshotInvalid(`overlay[${index}] object ID uses a different hash format.`);
    if (base.dirty !== undefined && typeof base.dirty !== "boolean") snapshotInvalid(`overlay[${index}].entry.dirty must be boolean.`);
    return {
      kind: "gitlink",
      oid,
      mode: snapshotMode(base.mode, [0o160000]),
      ...(base.dirty === true ? { dirty: true } : {})
    };
  }
  snapshotInvalid(`overlay[${index}].entry.kind is invalid.`);
}

function snapshotDiff(value: unknown): DiffContext {
  const data = strictObject(value, "diff", ["input", "patch", "stat", "nameStatus", "changedFiles"], ["gitlinks"]);
  const input = snapshotInput(data.input);
  for (const key of ["patch", "stat", "nameStatus"] as const) {
    if (typeof data[key] !== "string") snapshotInvalid(`diff.${key} must be a string.`);
  }
  const patchText = data.patch as string;
  const statText = data.stat as string;
  const nameStatus = data.nameStatus as string;
  if (!Array.isArray(data.changedFiles)) snapshotInvalid("diff.changedFiles must be an array.");
  const changedFiles = data.changedFiles.map((item, index) => {
    const changed = strictObject(item, `diff.changedFiles[${index}]`, ["status", "paths"]);
    if (typeof changed.status !== "string" || !/^(?:[ACDMRTUXB]|[RC]\d{1,3})$/.test(changed.status)) {
      snapshotInvalid(`diff.changedFiles[${index}].status is invalid.`);
    }
    if (!Array.isArray(changed.paths) || !changed.paths.length || changed.paths.length > 2) {
      snapshotInvalid(`diff.changedFiles[${index}].paths is invalid.`);
    }
    return {
      status: changed.status,
      paths: changed.paths.map((file, pathIndex) => snapshotPath(file, `diff.changedFiles[${index}].paths[${pathIndex}]`))
    };
  });
  let gitlinks: NonNullable<DiffContext["gitlinks"]> | undefined;
  if (data.gitlinks !== undefined) {
    if (!Array.isArray(data.gitlinks)) snapshotInvalid("diff.gitlinks must be an array.");
    gitlinks = data.gitlinks.map((item, index) => {
      const link = strictObject(item, `diff.gitlinks[${index}]`, ["path"], ["oldSha", "newSha", "dirty"]);
      if (link.dirty !== undefined && typeof link.dirty !== "boolean") snapshotInvalid(`diff.gitlinks[${index}].dirty must be boolean.`);
      return {
        path: snapshotPath(link.path, `diff.gitlinks[${index}].path`),
        ...(link.oldSha === undefined ? {} : { oldSha: snapshotOid(link.oldSha, `diff.gitlinks[${index}].oldSha`) }),
        ...(link.newSha === undefined ? {} : { newSha: snapshotOid(link.newSha, `diff.gitlinks[${index}].newSha`) }),
        ...(link.dirty === true ? { dirty: true } : {})
      };
    });
  }
  return {
    input,
    patch: patchText,
    stat: statText,
    nameStatus,
    changedFiles,
    ...(gitlinks === undefined ? {} : { gitlinks })
  };
}

function snapshotInput(value: unknown): ChangeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) snapshotInvalid("input must be an object.");
  const data = value as Record<string, unknown>;
  if (data.kind === "working-tree") {
    exactKeys(data, "input", ["kind"]);
    return { kind: "working-tree" };
  }
  exactKeys(data, "input", ["kind", "value"]);
  if (!["range", "commit", "file"].includes(String(data.kind)) || typeof data.value !== "string" || !data.value
    || hasControl(data.value)) {
    snapshotInvalid("input is invalid.");
  }
  if (data.kind === "file") return { kind: "file", value: snapshotPath(data.value, "input.value") };
  return { kind: data.kind as "range" | "commit", value: data.value };
}

async function availableTree(root: string, oid: string, requireCommit = false) {
  const type = await gitObjectType(root, oid).catch(() => null);
  if (!type || requireCommit && type !== "commit" || !["commit", "tree"].includes(type)) {
    throw new ChangeForgeError(
      `Source revision ${oid} is unavailable.`,
      "SOURCE_UNAVAILABLE",
      "Restore the repository and fetch the captured revision, then retry."
    );
  }
  try {
    return await readTree(root, oid);
  } catch {
    throw new ChangeForgeError(`Source revision ${oid} cannot be read.`, "SOURCE_UNAVAILABLE");
  }
}

function strictObject(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) snapshotInvalid(`${label} must be an object.`);
  const data = value as Record<string, unknown>;
  exactKeys(data, label, required, optional);
  return data;
}

function exactKeys(data: Record<string, unknown>, label: string, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(data);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(data, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    snapshotInvalid(`${label} has invalid keys.`);
  }
}

function snapshotPath(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.normalize(value) !== value
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || hasControl(value)) {
    snapshotInvalid(`${label} is unsafe.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || [".", "..", ".git"].includes(pathIdentity(part))
    || part.endsWith(".") || part.endsWith(" ") || /[<>:"|?*]/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) || reservedRepositoryPath(value)) {
    snapshotInvalid(`${label} is reserved.`);
  }
  return value;
}

function snapshotOid(value: unknown, label: string) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) snapshotInvalid(`${label} is invalid.`);
  return value;
}

function snapshotDigest(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) snapshotInvalid(`${label} is invalid.`);
  return value;
}

function snapshotMode(value: unknown, allowed: number[]) {
  if (typeof value !== "number" || !allowed.includes(value)) snapshotInvalid("Entry mode is invalid.");
  return value;
}

function canonicalBase64(value: unknown, label: string) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    snapshotInvalid(`${label} is not canonical base64.`);
  }
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) snapshotInvalid(`${label} is not canonical base64.`);
  return data;
}

function safeText(value: unknown, label: string) {
  if (typeof value !== "string" || hasControl(value)) snapshotInvalid(`${label} contains control characters.`);
  return value;
}

function digest(value: Buffer) {
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

function reservedRepositoryPath(value: string) {
  const identity = pathIdentity(value);
  return identity === ".changeforge-runtime" || identity.startsWith(".changeforge-runtime/")
    || identity === ".changeforge/runs" || identity.startsWith(".changeforge/runs/");
}

function pathDepth(value: string) {
  return value.split("/").length;
}

function comparePath(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function snapshotInvalid(message: string): never {
  throw new ChangeForgeError(`Invalid change snapshot: ${message}`, "CHANGE_SNAPSHOT_INVALID");
}

function safeRelative(value: string) {
  if (!value || value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) invalidPath(value);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) invalidPath(value);
  const relative = normalized.split(path.sep).join("/");
  if (reservedRepositoryPath(relative)) invalidPath(value);
  return relative;
}

function targetPath(root: string, file: string) {
  const relative = safeRelative(file);
  const target = path.resolve(root, ...relative.split("/"));
  const escaped = path.relative(path.resolve(root), target);
  if (escaped === ".." || escaped.startsWith(`..${path.sep}`)) invalidPath(file);
  return target;
}

function nulStrings(raw: Buffer) {
  return raw.toString().split("\0").filter(Boolean);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function invalidRef(ref: string): never {
  throw new ChangeForgeError(`Invalid Git revision: ${ref}`, "GIT_REF_INVALID");
}

function invalidPath(file: string): never {
  throw new ChangeForgeError(`Invalid repository path: ${file}`, "GIT_PATH_INVALID");
}

function emptyChange(): never {
  throw new ChangeForgeError("The selected input contains no changes.", "GIT_EMPTY_CHANGE");
}
