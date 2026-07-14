import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

export async function makeTempDir() {
  return realpath(await mkdtemp(join(tmpdir(), "changeforge-")));
}

export async function writeJson(root: string, file: string, value: unknown) {
  const full = join(root, file);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, `${JSON.stringify(value, null, 2)}\n`);
}

export async function touch(root: string, file: string) {
  const full = join(root, file);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "");
}

export async function makeGitRepo() {
  const repo = await makeTempDir();
  await execa("git", ["init"], { cwd: repo });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "Test User"], { cwd: repo });
  await execa("git", ["config", "core.autocrlf", "false"], { cwd: repo });
  return repo;
}

export function prependPath(directory: string, env: NodeJS.ProcessEnv = process.env) {
  return `${directory}${delimiter}${env.PATH ?? ""}`;
}

async function makeNodeExecutable(name: string, source: string) {
  const dir = await makeTempDir();
  await writeFile(join(dir, name), `#!/usr/bin/env node\n${source}`);
  await chmod(join(dir, name), 0o755);
  await writeFile(join(dir, `${name}.cjs`), source);
  await writeFile(join(dir, `${name}.cmd`), `@node "%~dp0${name}.cjs" %*\r\n`);
  return dir;
}

export async function makeFakeCodex() {
  return makeNodeExecutable("codex", `
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") process.exit(0);
if (args[0] === "exec" && args[1] === "--help") { console.log("--ephemeral"); process.exit(0); }
if (args[0] === "--version") {
  console.log("codex-cli 0.0.0");
  process.exit(0);
}
const fs = require("fs");
const path = require("path");
const prompt = fs.readFileSync(0, "utf8");
if (process.env.CODEX_INVOCATION_LOG) fs.appendFileSync(process.env.CODEX_INVOCATION_LOG, "codex\\n");
const out = args[args.indexOf("--output-last-message") + 1];
const review = prompt.startsWith("You are ChangeForge, a read-only change reviewer.");
if (process.env.MUTATE_REVIEW && review) fs.writeFileSync("src.js", "tampered\\n");
if (process.env.ORDER_LOG && prompt.startsWith("Generated Playwright coverage failed.")) fs.appendFileSync(process.env.ORDER_LOG, "repair\\n");
const generated = prompt.match(/Generated edge-case spec file:\\n([^\\n]+)/)?.[1]?.trim();
if (generated) {
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  fs.writeFileSync(generated, "import { test, expect } from '@playwright/test';\\n\\ntest('fake generated edge case', async ({ page }) => {\\n  await page.goto('/');\\n  await expect(page.locator('body')).toBeVisible();\\n});\\n");
}
if (out) fs.writeFileSync(out, review
  ? process.env.INVALID_REVIEW || JSON.stringify({ schemaVersion: "1.0", findings: [{ title: "Fake review finding", severity: "medium", confidence: 0.9, file: "src.js", line: 1, evidence: process.env.ECHO_CODEX_CWD ? process.cwd() : "The changed value may alter consumers.", suggestedValidation: "Run a consumer regression test." }] }) + "\\n"
  : "fake codex output\\n");
process.exit(0);
`);
}

export async function makeTimeoutCodex() {
  return makeNodeExecutable("codex", `
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") process.exit(0);
if (args[0] === "exec" && args[1] === "--help") { console.log("--ephemeral"); process.exit(0); }
if (args[0] === "--version") {
  console.log("codex-cli 0.0.0");
  process.exit(0);
}
const fs = require("fs");
const path = require("path");
const prompt = fs.readFileSync(0, "utf8");
const out = args[args.indexOf("--output-last-message") + 1];
const generated = prompt.match(/Generated edge-case spec file:\\n([^\\n]+)/)?.[1]?.trim();
if (generated) {
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  fs.writeFileSync(generated, "import { test, expect } from '@playwright/test';\\n\\ntest('timeout edge case', async ({ page }) => {\\n  await page.goto('/');\\n  await expect(page.locator('body')).toBeVisible();\\n});\\n");
  setTimeout(() => {}, 10000);
} else {
  if (out) fs.writeFileSync(out, JSON.stringify({ schemaVersion: "1.0", findings: [] }) + "\\n");
  process.exit(0);
}
`);
}

export async function makeFailingCodex() {
  return makeNodeExecutable("codex", `
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") process.exit(0);
if (args[0] === "exec" && args[1] === "--help") { console.log("--ephemeral"); process.exit(0); }
if (args[0] === "--version") {
  console.log("codex-cli 0.0.0");
  process.exit(0);
}
console.error("fake codex failure");
process.exit(7);
`);
}

export async function makeInstallingNpm(fail = false) {
  return makeNodeExecutable("npm", `
const fs = require("fs");
if (process.env.INSTALL_LOG) fs.writeFileSync(process.env.INSTALL_LOG, JSON.stringify(process.argv.slice(2)));
if (${fail}) process.exit(9);
const file = "package.json";
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.devDependencies = { ...(pkg.devDependencies || {}), "@playwright/test": "1" };
fs.writeFileSync(file, JSON.stringify(pkg));
process.exit(0);
`);
}

export async function makeRecordingNpm() {
  return makeNodeExecutable("npm", `
const fs = require("fs");
fs.appendFileSync(process.env.NPM_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.env.NPM_FAIL_ONCE_STATE && !fs.existsSync(process.env.NPM_FAIL_ONCE_STATE)) {
  fs.writeFileSync(process.env.NPM_FAIL_ONCE_STATE, "failed");
  process.exit(1);
}
`);
}

export async function makePlaywrightNpm(exitCode = 0) {
  return makeNodeExecutable("npm", `
const fs = require("fs");
const path = require("path");
if (process.env.PLAYWRIGHT_INVOCATION_LOG) fs.appendFileSync(process.env.PLAYWRIGHT_INVOCATION_LOG, "playwright\\n");
const report = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR;
if (report) {
  fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, "index.html"), "<html>native playwright report ${exitCode}</html>");
}
process.exit(${exitCode});
`);
}
