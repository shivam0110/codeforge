import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../runners/command.js";
import { writeJsonContained, writeTextContained } from "../utils/fs.js";
import { makeSecureTemp, removeSecureTemp } from "../utils/temp.js";
import { isolatedGitEnv } from "./env.js";

export type ManifestEntry =
  | { kind: "file"; data: Buffer; mode: number }
  | { kind: "symlink"; linkText: string; mode: number };

export type PatchBaseline = {
  root: string;
  artifactRoot: string;
  excluded: string | null;
  ignored: string[];
  entries: Map<string, ManifestEntry>;
};

export async function createPatchBaseline(
  root: string,
  runDir: string,
  artifactRoot = commonAncestor(root, runDir),
  ignored: string[] = []
): Promise<PatchBaseline> {
  const relative = path.relative(path.resolve(root), path.resolve(runDir));
  const excluded = relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) ? normalize(relative) : null;
  return { root, artifactRoot, excluded, ignored: ignored.map(normalize), entries: await readManifest(root, excluded, ignored) };
}

export async function savePatch(root: string, baseline: PatchBaseline, outFile: string) {
  const final = await readManifest(root, baseline.excluded, baseline.ignored);
  const patch = await manifestPatch(baseline.entries, final);
  await writeTextContained(baseline.artifactRoot, outFile, patch);
  return Buffer.byteLength(patch);
}

export async function saveChangedFiles(root: string, baseline: PatchBaseline, outFile: string) {
  const files = changedPaths(baseline.entries, await readManifest(root, baseline.excluded, baseline.ignored));
  await writeJsonContained(baseline.artifactRoot, outFile, files);
  return files;
}

export async function readManifest(root: string, excluded: string | null = null, ignored: string[] = []) {
  const entries = new Map<string, ManifestEntry>();
  await walk(root, "", entries, excluded, ignored.map(normalize));
  return entries;
}

export async function manifestPatch(before: Map<string, ManifestEntry>, after: Map<string, ManifestEntry>, timeoutMs = 60000) {
  const temp = await makeSecureTemp("changeforge-patch-");
  try {
    const gitDir = path.join(temp, "objects.git");
    await patchGit(temp, ["init", "--bare", "--quiet", gitDir], timeoutMs);
    const oldTree = await manifestTree(temp, gitDir, path.join(temp, "before.index"), before, timeoutMs);
    const newTree = await manifestTree(temp, gitDir, path.join(temp, "after.index"), after, timeoutMs);
    if (oldTree === newTree) return "";
    return await patchGit(temp, [
      `--git-dir=${gitDir}`, "diff-tree", "--no-commit-id", "-p", "--binary", "--no-ext-diff",
      "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", oldTree, newTree
    ], timeoutMs);
  } finally {
    await removeSecureTemp(temp, "changeforge-patch-");
  }
}

export function changedPaths(before: Map<string, ManifestEntry>, after: Map<string, ManifestEntry>) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => !same(before.get(file), after.get(file)))
    .sort();
}

async function walk(root: string, relative: string, out: Map<string, ManifestEntry>, excluded: string | null, ignored: string[]): Promise<void> {
  const dir = path.join(root, relative);
  const names = await fs.readdir(dir, { withFileTypes: true });
  for (const item of names.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = relative ? path.join(relative, item.name) : item.name;
    if (runtimeArtifact(next, excluded, ignored)) continue;
    const full = path.join(root, next);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) {
      out.set(normalize(next), { kind: "symlink", linkText: await fs.readlink(full), mode: 0o120000 });
    } else if (stat.isDirectory()) {
      await walk(root, next, out, excluded, ignored);
    } else if (stat.isFile()) {
      out.set(normalize(next), { kind: "file", data: await fs.readFile(full), mode: stat.mode & 0o111 ? 0o100755 : 0o100644 });
    }
  }
}

async function manifestTree(
  cwd: string,
  gitDir: string,
  indexFile: string,
  manifest: Map<string, ManifestEntry>,
  timeoutMs: number
) {
  const env = { GIT_DIR: gitDir, GIT_INDEX_FILE: indexFile };
  await patchGit(cwd, ["read-tree", "--empty"], timeoutMs, undefined, env);
  const rows: Buffer[] = [];
  for (const [file, entry] of [...manifest].sort(([left], [right]) => left.localeCompare(right))) {
    const data = entry.kind === "file" ? entry.data : Buffer.from(entry.linkText);
    const oid = (await patchGit(cwd, ["hash-object", "-w", "--stdin"], timeoutMs, data, env)).trim();
    rows.push(Buffer.from(`${entry.mode.toString(8)} ${oid}\t${file}\0`));
  }
  if (rows.length) await patchGit(cwd, ["update-index", "-z", "--index-info"], timeoutMs, Buffer.concat(rows), env);
  return (await patchGit(cwd, ["write-tree"], timeoutMs, undefined, env)).trim();
}

async function patchGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
  input?: Buffer,
  extraEnv: NodeJS.ProcessEnv = {}
) {
  const result = await runCommand("git", args, {
    cwd, input, check: false, timeoutMs,
    env: isolatedGitEnv(extraEnv), extendEnv: false
  });
  if (!result.exitCodeKnown || result.exitCode !== 0 || result.errorCode
    || result.signal || result.timedOut || result.isCanceled) {
    throw new Error(`Cannot create patch: ${result.stderr || result.stdout || result.errorCode || result.exitCode}`);
  }
  return result.stdout;
}

function same(left?: ManifestEntry, right?: ManifestEntry) {
  if (!left || !right || left.kind !== right.kind || left.mode !== right.mode) return false;
  return left.kind === "file" && right.kind === "file"
    ? left.data.equals(right.data)
    : left.kind === "symlink" && right.kind === "symlink" && left.linkText === right.linkText;
}

function runtimeArtifact(file: string, excluded: string | null, ignored: string[]) {
  const value = normalize(file);
  if (excluded && (value === excluded || value.startsWith(`${excluded}/`))) return true;
  if (ignored.some((dir) => value === dir || value.startsWith(`${dir}/`))) return true;
  if (value === ".changeforge-runtime" || value.startsWith(".changeforge-runtime/")) return true;
  if (value.split("/").some((part) => [".git", "node_modules", ".pnpm-store"].includes(part))) return true;
  if (value.includes("/.yarn/cache/") || value.startsWith(".yarn/cache/")) return true;
  return false;
}

function normalize(file: string) {
  return file.split(path.sep).join("/");
}

function commonAncestor(left: string, right: string) {
  const a = path.resolve(left).split(path.sep);
  const b = path.resolve(right).split(path.sep);
  let index = 0;
  while (index < a.length && a[index] === b[index]) index += 1;
  return a.slice(0, index).join(path.sep) || path.parse(path.resolve(left)).root;
}
