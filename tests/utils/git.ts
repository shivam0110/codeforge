import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { makeTempDir } from "./fs.js";

export async function git(root: string, args: string[], input?: string | Buffer) {
  const result = await execa("git", args, { cwd: root, input, reject: false, encoding: "buffer" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  return Buffer.from(result.stdout);
}

export async function committedRepo(files: Record<string, string | Buffer>) {
  const root = await makeTempDir();
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFiles(root, files);
  await git(root, ["add", "--", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

export async function commitFiles(root: string, files: Record<string, string | Buffer>, message = "change") {
  await writeFiles(root, files);
  await git(root, ["add", "--", "."]);
  await git(root, ["commit", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).toString().trim();
}

async function writeFiles(root: string, files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
