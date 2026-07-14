import fs from "node:fs/promises";
import path from "node:path";
import type { DiffContext, FileSnapshot } from "../core/types.js";
import { ChangeForgeError } from "../core/errors.js";
import { existsContained } from "../utils/fs.js";

const maxSnapshotChars = 40000;

export async function collectFileSnapshots(root: string, diff: DiffContext): Promise<FileSnapshot[]> {
  const gitlinks = diff.gitlinks?.length
    ? new Map(diff.gitlinks.map(({ path: filePath, ...item }) => [filePath, item]))
    : parseGitlinks(diff.patch);
  const modules = parseGitmodules(await readRepoText(root, ".gitmodules"));
  return Promise.all(diff.changedFiles.map((file) => snapshotFile(root, file.status, file.paths.at(-1) ?? "", gitlinks, modules)));
}

async function snapshotFile(
  root: string,
  status: string,
  filePath: string,
  gitlinks: Map<string, Pick<FileSnapshot, "oldSha" | "newSha">>,
  modules: Map<string, Pick<FileSnapshot, "url" | "branch">>
): Promise<FileSnapshot> {
  if (!filePath || status.startsWith("D")) return { path: filePath, status, kind: "deleted", exists: false, content: "" };
  const gitlink = gitlinks.get(filePath);
  if (gitlink) {
    return {
      path: filePath,
      status,
      kind: "gitlink",
      exists: false,
      content: "",
      ...gitlink,
      ...modules.get(filePath),
      initialized: await existsContained(root, path.join(root, filePath, ".git"))
    };
  }
  const full = contained(root, filePath);
  const entry = await fs.lstat(full).catch(() => null);
  if (entry?.isSymbolicLink()) {
    return { path: filePath, status, kind: "symlink", exists: true, content: await fs.readlink(full) };
  }
  const present = Boolean(entry?.isFile());
  const content = present ? await readContainedFile(root, full) : "";
  return {
    path: filePath,
    status,
    kind: present ? "file" : "missing",
    exists: present,
    content: content.slice(0, maxSnapshotChars),
    truncated: content.length > maxSnapshotChars || undefined
  };
}

async function readRepoText(root: string, filePath: string) {
  const full = contained(root, filePath);
  const entry = await fs.lstat(full).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink()) return "";
  return readContainedFile(root, full);
}

async function readContainedFile(root: string, file: string) {
  const [base, target] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new ChangeForgeError(`Snapshot path escapes repository: ${file}`, "SNAPSHOT_OUTSIDE_REPO");
  }
  return fs.readFile(target, "utf8");
}

function contained(root: string, filePath: string) {
  const base = path.resolve(root);
  const target = path.resolve(base, filePath);
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new ChangeForgeError(`Snapshot path escapes repository: ${filePath}`, "SNAPSHOT_OUTSIDE_REPO");
  }
  return target;
}

function parseGitlinks(patch: string) {
  const out = new Map<string, Pick<FileSnapshot, "oldSha" | "newSha">>();
  for (const part of patch.split(/^diff --git /m).filter(Boolean)) {
    if (!part.includes(" 160000")) continue;
    const filePath = part.match(/^a\/.+ b\/(.+)$/m)?.[1];
    if (!filePath) continue;
    out.set(filePath, {
      oldSha: part.match(/^-Subproject commit\s+([0-9a-f]+)/m)?.[1] ?? part.match(/^index\s+([0-9a-f]+)\.\./m)?.[1],
      newSha: part.match(/^\+Subproject commit\s+([0-9a-f]+)/m)?.[1] ?? part.match(/^index\s+[0-9a-f]+\.\.([0-9a-f]+)/m)?.[1]
    });
  }
  return out;
}

function parseGitmodules(text: string) {
  const out = new Map<string, Pick<FileSnapshot, "url" | "branch">>();
  let item: Partial<Pick<FileSnapshot, "path" | "url" | "branch">> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[submodule ")) {
      if (item.path) out.set(item.path, { url: item.url, branch: item.branch });
      item = {};
      continue;
    }
    const match = line.match(/^(path|url|branch)\s*=\s*(.+)$/);
    if (match) item[match[1] as "path" | "url" | "branch"] = match[2];
  }
  if (item.path) out.set(item.path, { url: item.url, branch: item.branch });
  return out;
}
