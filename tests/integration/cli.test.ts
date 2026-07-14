import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli, runCliResult } from "../utils/cli.js";
import {
  makeFailingCodex,
  makeFakeCodex,
  makeGitRepo,
  makeInstallingNpm,
  makePlaywrightNpm,
  makeRecordingNpm,
  makeTempDir,
  makeTimeoutCodex,
  prependPath,
  writeJson,
} from "../utils/fs.js";

async function expectNoSandbox(stdout: string) {
  await expect(stat(sandboxPath(stdout))).rejects.toThrow();
}

function sandboxPath(stdout: string) {
  const sandbox = stdout.match(/ChangeForge: sandbox (.+)/)?.[1];
  if (!sandbox) throw new Error("Sandbox path was not logged.");
  return sandbox;
}

async function inspectView(repo: string, runId: string) {
  const result = await runCli([
    "inspect",
    "--repo",
    repo,
    "--run",
    runId,
    "--json",
  ]);
  return JSON.parse(result.stdout);
}

describe("CLI integration", () => {
  test("init creates config and gitignore entries", async () => {
    const repo = await makeGitRepo();

    await runCli(["init", "--repo", repo]);

    await expect(
      stat(join(repo, ".changeforge/config.json")),
    ).resolves.toBeTruthy();
    await expect(readFile(join(repo, ".gitignore"), "utf8")).resolves.toContain(
      ".changeforge/runs/",
    );
    await expect(readFile(join(repo, ".gitignore"), "utf8")).resolves.toContain(
      ".changeforge/locks/",
    );
    await expect(readFile(join(repo, ".gitignore"), "utf8")).resolves.toContain(
      "changeforge/*/",
    );
    await expect(
      readFile(join(repo, ".gitignore"), "utf8"),
    ).resolves.not.toContain(".changeforge/worktrees/");
  });

  test("init refuses to write through a symlinked runtime directory", async () => {
    const repo = await makeGitRepo();
    const outside = await makeTempDir();
    await symlink(outside, join(repo, ".changeforge"));

    await expect(runCli(["init", "--repo", repo])).rejects.toThrow(/symlink/i);
    await expect(stat(join(outside, "config.json"))).rejects.toThrow();
  });

  test("review-only run isolates writes and publishes review artifacts", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, "package.json", { scripts: { test: "node --test" } });
    await writeFile(join(repo, "src.js"), "export const value = 1;\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "export const value = 2;\n");
    await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
      cwd: repo,
      passthrough: true,
    });
    const fakeBin = await makeFakeCodex();

    const result = await runCli(["run", "--repo", repo, "--range", "HEAD~1..HEAD"], {
      env: { PATH: prependPath(fakeBin), MUTATE_REVIEW: "1", ECHO_CODEX_CWD: "1" },
    });

    const runsDir = join(repo, ".changeforge/runs");
    const [runId] = await import("node:fs/promises").then((fs) =>
      fs.readdir(runsDir),
    );
    const publicFiles = await readdir(join(repo, "changeforge", runId));
    expect(publicFiles).not.toContain("changes-review.md");
    expect(publicFiles).not.toContain("change-report.md");
    await expect(
      readFile(join(repo, "changeforge", runId, "code-review.md"), "utf8"),
    ).resolves.toContain("Fake review finding");
    const findings = (await inspectView(repo, runId)).findings.document;
    expect(findings.schemaVersion).toBe("1.0");
    expect(findings.findings[0].id).toMatch(/^CF1-[a-f0-9]{64}$/);
    expect(findings.findings[0].evidence).toBe(
      result.stdout.match(/ChangeForge: sandbox (.+)/)?.[1],
    );
    expect(result.stdout).not.toContain("changes review");
    expect((await readdir(join(runsDir, runId))).sort()).toEqual([
      "artifacts",
      "run-manifest.v1.json",
    ]);
    expect(await readdir(join(runsDir, runId, "artifacts"))).toEqual([
      "immutable",
    ]);
    await expect(readFile(join(repo, "src.js"), "utf8")).resolves.toBe(
      "export const value = 2;\n",
    );

    await mkdir(join(runsDir, runId, "logs"));
    await writeFile(join(runsDir, runId, "logs/old.log"), "old\n");
    const preview = await runCli([
      "clean",
      "--repo",
      repo,
      "--keep",
      "1",
      "--dry-run",
    ]);
    expect(preview.stdout).toContain(`Would compact: ${runId}`);
    const cleaned = await runCli(["clean", "--repo", repo, "--keep", "1"]);
    expect(cleaned.stdout).toContain(`Compacted: ${runId}`);
    await expect(stat(join(runsDir, runId, "logs"))).rejects.toThrow();
  });

  test("report resolves requested run report path", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    const report = join(repo, "changeforge/run-1");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(report, { recursive: true }),
    );
    await mkdir(join(report, "playwright-report"), { recursive: true });
    await writeFile(
      join(report, "playwright-report/index.html"),
      "<html></html>",
    );

    const result = await runCli([
      "report",
      "--repo",
      repo,
      "--run",
      "run-1",
      "--no-open",
    ]);

    expect(result.stdout).toContain(
      await realpath(join(report, "playwright-report/index.html")),
    );

    const reviewOnly = join(repo, "changeforge/run-2");
    await mkdir(reviewOnly, { recursive: true });
    await writeFile(join(reviewOnly, "code-review.md"), "# Review\n");
    const fallback = await runCli([
      "report",
      "--repo",
      repo,
      "--run",
      "run-2",
      "--no-open",
    ]);
    expect(fallback.stdout).toContain("Code review:");
    expect(fallback.stdout).toContain("changeforge/run-2/code-review.md");
  });

  test("clean previews, selects, retains, and removes runs", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    const runs = join(repo, ".changeforge/runs");
    for (const runId of ["run-1", "run-2", "run-3"])
      await mkdir(join(runs, runId), { recursive: true });
    await utimes(join(runs, "run-1"), new Date(1), new Date(1));
    await utimes(join(runs, "run-2"), new Date(2), new Date(2));
    await utimes(join(runs, "run-3"), new Date(3), new Date(3));

    const preview = await runCli([
      "clean",
      "--repo",
      repo,
      "--run",
      "run-1",
      "--dry-run",
    ]);
    expect(preview.stdout).toContain("Would remove: run-1");
    await expect(stat(join(runs, "run-1"))).resolves.toBeTruthy();

    const one = await runCli(["clean", "--repo", repo, "--run", "run-1"]);
    expect(one.stdout).toContain("Removed: run-1");
    await expect(stat(join(runs, "run-1"))).rejects.toThrow();

    await runCli(["clean", "--repo", repo, "--keep", "1"]);
    await expect(stat(join(runs, "run-2"))).rejects.toThrow();
    await expect(stat(join(runs, "run-3"))).resolves.toBeTruthy();

    await runCli(["clean", "--repo", repo]);
    await expect(stat(join(runs, "run-3"))).rejects.toThrow();

    for (let index = 0; index < 11; index += 1) {
      const legacy = join(runs, `legacy-${String(index).padStart(2, "0")}`);
      await mkdir(join(legacy, "logs"), { recursive: true });
      await utimes(legacy, new Date(index + 1), new Date(index + 1));
    }
    await runCli(["clean", "--repo", repo, "--keep", "10"]);
    expect(await readdir(runs)).toHaveLength(10);
    await expect(stat(join(runs, "legacy-00"))).rejects.toThrow();
    await expect(stat(join(runs, "legacy-10/logs"))).resolves.toBeTruthy();
  });

  test("maps a failed executed command to a failed summary and nonzero exit", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, "package.json", {
      scripts: { test: 'node -e "process.exit(7)"' },
    });
    await writeFile(join(repo, "src.js"), "one\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "two\n");
    await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
      cwd: repo,
      passthrough: true,
    });
    const codex = await makeFakeCodex();

    const failed = await runCliResult(
      [
        "run",
        "--repo",
        repo,
        "--range",
        "HEAD~1..HEAD",
        "--execute",
        "--no-playwright",
      ],
      { env: { PATH: prependPath(codex) } },
    );
    expect(failed.exitCode).toBe(1);

    const [runId] = await readdir(join(repo, ".changeforge/runs"));
    expect((await inspectView(repo, runId)).summary.status).toBe("failed");
    expect((await readdir(join(repo, ".changeforge/runs", runId))).sort()).toEqual([
      "artifacts",
      "run-manifest.v1.json",
    ]);
  });

  test("installs only with execution consent and refreshes project detection", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, "package.json", {});
    await writeFile(join(repo, "src.js"), "one\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "two\n");
    await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
      cwd: repo,
      passthrough: true,
    });
    const codex = await makeFakeCodex();
    const npm = await makeInstallingNpm();
    const installLog = join(await makeTempDir(), "install.json");
    const env = {
      PATH: prependPath(npm, { ...process.env, PATH: prependPath(codex) }),
      INSTALL_LOG: installLog,
    };

    await expect(
      runCli(
        ["run", "--repo", repo, "--range", "HEAD~1..HEAD", "--install-deps"],
        { env },
      ),
    ).rejects.toThrow("requires --execute");
    await runCli(
      [
        "run",
        "--repo",
        repo,
        "--range",
        "HEAD~1..HEAD",
        "--execute",
        "--install-deps",
        "--no-unit",
        "--no-playwright",
      ],
      { env },
    );

    expect(JSON.parse(await readFile(installLog, "utf8"))).toContain(
      "--ignore-scripts",
    );
    const runs = await readdir(join(repo, ".changeforge/runs"));
    const latest = runs.sort().at(-1)!;
    const summary = (await inspectView(repo, latest)).summary;
    expect(summary.project.hasPlaywright).toBe(true);
  });

  test("preserves the native Playwright report when Playwright fails", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, ".changeforge/config.json", {
      webServer: { command: "node server.js", url: "http://127.0.0.1:3000" },
    });
    await writeJson(repo, "package.json", {
      devDependencies: { "@playwright/test": "1" },
    });
    await mkdir(join(repo, "node_modules"));
    await writeFile(join(repo, "src.js"), "one\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "two\n");
    await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
      cwd: repo,
      passthrough: true,
    });
    const codex = await makeFakeCodex();
    const npm = await makePlaywrightNpm(1);
    const state = await makeTempDir();
    const codexLog = join(state, "codex.log");
    const playwrightLog = join(state, "playwright.log");

    const result = await runCliResult(
      [
        "run",
        "--repo",
        repo,
        "--range",
        "HEAD~1..HEAD",
        "--generate",
        "--execute",
        "--no-unit",
      ],
      {
        env: {
          PATH: prependPath(npm, { PATH: prependPath(codex) }),
          CODEX_INVOCATION_LOG: codexLog,
          PLAYWRIGHT_INVOCATION_LOG: playwrightLog,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    const [runId] = await readdir(join(repo, ".changeforge/runs"));
    const summary = (await inspectView(repo, runId)).summary;
    expect(summary.status).toBe("failed");
    expect(
      summary.playwrightReport.endsWith(
        join("changeforge", runId, "playwright-report/index.html"),
      ),
    ).toBe(true);
    await expect(readFile(summary.playwrightReport, "utf8")).resolves.toContain(
      "report 1",
    );
    await expect(readFile(playwrightLog, "utf8")).resolves.toBe("playwright\n");
    await expect(readFile(codexLog, "utf8")).resolves.toBe("codex\ncodex\n");
    await expectNoSandbox(result.stdout);
  });

  test("generates and executes a run-scoped sidecar beside an existing e2e target", async () => {
    const repo = await makeGitRepo();
    const existing = join(repo, "tests/e2e/existing.spec.ts");
    const existingSource =
      "import { test } from '@playwright/test';\ntest('existing', async () => {});\n";
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, ".changeforge/config.json", {
      playwright: { e2eTestPath: "tests/e2e/existing.spec.ts" },
    });
    await writeJson(repo, "package.json", {
      devDependencies: { "@playwright/test": "1" },
    });
    await mkdir(join(repo, "node_modules"));
    await mkdir(join(repo, "tests/e2e"), { recursive: true });
    await writeFile(existing, existingSource);
    await writeFile(join(repo, "playwright.config.ts"), "export default {};\n");
    await writeFile(join(repo, "src.js"), "one\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "two\n");
    await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
      cwd: repo,
      passthrough: true,
    });
    const codex = await makeFakeCodex();
    const npm = await makeRecordingNpm();
    const npmState = await makeTempDir();
    const npmLog = join(npmState, "npm.log");

    const result = await runCli(
      [
        "run",
        "--repo",
        repo,
        "--range",
        "HEAD~1..HEAD",
        "--generate",
        "--execute",
        "--no-unit",
        "--keep-sandbox",
      ],
      {
        env: {
          PATH: prependPath(npm, { ...process.env, PATH: prependPath(codex) }),
          NPM_LOG: npmLog,
        },
      },
    );

    const [runId] = await readdir(join(repo, ".changeforge/runs"));
    const workRoot = sandboxPath(result.stdout);
    const sidecar = "existing.spec.ts";
    const generatedTestFile = join(
      workRoot,
      "tests/e2e",
      `changeforge-${runId}`,
      sidecar,
    );
    await expect(readFile(existing, "utf8")).resolves.toBe(existingSource);
    await expect(
      readFile(join(workRoot, "tests/e2e/existing.spec.ts"), "utf8"),
    ).resolves.toBe(existingSource);
    await expect(
      readFile(generatedTestFile, "utf8"),
    ).resolves.toContain("fake generated edge case");
    await expect(
      readFile(join(repo, "changeforge", runId, sidecar), "utf8"),
    ).resolves.toContain("fake generated edge case");
    const npmArgs = await readFile(npmLog, "utf8");
    const invocations = npmArgs.trim().split("\n");
    expect(invocations).toHaveLength(1);
    for (const invocation of invocations) {
      expect(invocation).toContain(generatedTestFile);
      expect(invocation).toContain(
        join(workRoot, "playwright.config.ts"),
      );
      expect(invocation).not.toContain(
        join(workRoot, "tests/e2e/existing.spec.ts"),
      );
    }
  });

  test("normal run lets Codex create the configured generated test file", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, ".changeforge/config.json", {
      webServer: { command: "node server.js", url: "http://127.0.0.1:3000" },
    });
    await writeJson(repo, "package.json", {
      scripts: { test: 'node -e "process.exit(0)"' },
      devDependencies: { "@playwright/test": "latest" },
    });
    await writeFile(join(repo, "src.js"), "export const value = 1;\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "export const value = 2;\n");
    await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
      cwd: repo,
      passthrough: true,
    });
    const fakeBin = await makeFakeCodex();

    const result = await runCli(
      [
        "run",
        "--repo",
        repo,
        "--range",
        "HEAD~1..HEAD",
        "--generate",
        "--execute",
        "--playwright-command",
        'node -e "process.exit(0)" {testFile}',
      ],
      {
        env: { PATH: prependPath(fakeBin) },
      },
    );

    const [runId] = await readdir(join(repo, ".changeforge/runs"));
    await expect(
      readFile(
        join(repo, "changeforge", runId, "test-edge-cases.spec.ts"),
        "utf8",
      ),
    ).resolves.toContain("fake generated edge case");
    await expectNoSandbox(result.stdout);
  });

  test("failed run removes isolated sandbox after writing partial summary", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, "package.json", {
      scripts: { test: 'node -e "process.exit(0)"' },
    });
    await writeFile(join(repo, "src.js"), "export const value = 1;\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "export const value = 2;\n");
    await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
      cwd: repo,
      passthrough: true,
    });
    const fakeBin = await makeFailingCodex();

    const failed = await runCliResult(
      ["run", "--repo", repo, "--range", "HEAD~1..HEAD"],
      {
        env: { PATH: prependPath(fakeBin) },
      },
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("Codex task failed");

    const [runId] = await readdir(join(repo, ".changeforge/runs"));
    expect((await inspectView(repo, runId)).summary.status).toBe("failed");
    await expectNoSandbox(failed.stdout);
  });

  test("rejects timed-out Codex generation even when staging contains a spec", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, ".changeforge/config.json", {
      codex: { timeoutMs: 1000 },
      playwrightCommand: 'node -e "process.exit(0)"',
      webServer: { command: "node server.js", url: "http://127.0.0.1:3000" },
    });
    await writeJson(repo, "package.json", {
      scripts: { test: 'node -e "process.exit(0)"' },
      devDependencies: { "@playwright/test": "latest" },
    });
    await writeFile(join(repo, "src.js"), "export const value = 1;\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "export const value = 2;\n");
    await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
      cwd: repo,
      passthrough: true,
    });
    const fakeBin = await makeTimeoutCodex();

    await expect(
      runCli(["run", "--repo", repo, "--range", "HEAD~1..HEAD", "--generate"], {
        env: { PATH: prependPath(fakeBin) },
      }),
    ).rejects.toThrow("timed out");

    const [runId] = await import("node:fs/promises").then((fs) =>
      fs.readdir(join(repo, ".changeforge/runs")),
    );
    await expect(
      stat(join(repo, "changeforge", runId, "test-edge-cases.spec.ts")),
    ).rejects.toThrow();
    const summary = (await inspectView(repo, runId)).summary;
    expect(summary.status).toBe("failed");
    expect(summary.findings).toMatchObject({ schemaVersion: "1.0", total: 0 });
  });
});
