import { repoRoot } from "../git/repo.js";
import { detectProject } from "../project/detect.js";
import { pmExecSpec } from "../project/package-manager.js";
import { commandOk, runCommand } from "../runners/command.js";

export async function doctorCommand(options: { repo?: string; json?: boolean }) {
  const checks = [
    await versionCheck("git", ["--version"]),
    await versionCheck("node", ["--version"]),
    await versionCheck("npm", ["--version"]),
    await versionCheck("codex", ["--version"]),
    await codexLoginCheck()
  ];
  let root: string | null = null;
  let project = null;
  try {
    root = await repoRoot(options.repo ?? process.cwd());
    project = await detectProject(root);
  } catch (error) {
    checks.push({ name: "repo", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  const guidance = project?.hasPlaywright && project.packageManager ? [
    `Verify browser binaries: ${pmExecSpec(project.packageManager, "playwright", ["install", "--list"]).display}`,
    `Install Chromium if needed: ${pmExecSpec(project.packageManager, "playwright", ["install", "chromium"]).display}`
  ] : [];
  const payload = { ok: checks.every((check) => check.ok), checks, repo: root, project, guidance };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
  console.log("ChangeForge doctor\n");
  for (const check of checks) console.log(`${(check.ok ? "OK" : "FAIL").padEnd(5)} ${check.name.padEnd(14)} ${check.detail}`);
  if (project) {
    console.log("\nProject detection");
    console.log(`  package manager: ${project.packageManager ?? "none"}`);
    console.log(`  unit command: ${project.suggestedUnitCommand ?? "not detected"}`);
    console.log(`  playwright: ${project.hasPlaywright ? "detected" : "missing"}`);
    for (const item of guidance) console.log(`  ${item}`);
  }
  return payload;
}

async function versionCheck(name: string, args: string[]) {
  const result = await runCommand(name, args, { check: false, timeoutMs: 10000 }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) }));
  return { name, ok: result.exitCode === 0, detail: firstLine(result.stdout) || firstLine(result.stderr) };
}

function firstLine(value: string) {
  return value.trim().split(/\r?\n/)[0] ?? "";
}

async function codexLoginCheck() {
  const ok = await commandOk("codex", ["login", "status"]).catch(() => false);
  return { name: "codex auth", ok, detail: ok ? "logged in" : "not logged in" };
}
