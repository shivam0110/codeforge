import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { setPhase } from "../../src/core/run-manifest.js";
import { loadRunManifest, saveRunManifest } from "../../src/core/run-store.js";
import { applyGeneratedOverlay } from "../../src/git/generated-overlay.js";
import { runCli, runCliResult } from "../utils/cli.js";
import {
  makeFailingCodex,
  makeFakeCodex,
  makeGitRepo,
  makeTempDir,
  prependPath,
  writeJson,
} from "../utils/fs.js";

async function expectCompacted(run: string) {
  expect((await readdir(run)).sort()).toEqual([
    "artifacts",
    "run-manifest.v1.json",
  ]);
  expect(await readdir(join(run, "artifacts"))).toEqual(["immutable"]);
}

async function generatedRun(
  playwrightCommand = 'node -e "process.exit(0)" {testFile}',
  unitCommand = 'node -e "process.exit(0)"',
) {
  const repo = await makeGitRepo();
  await runCli(["init", "--repo", repo]);
  await writeJson(repo, ".changeforge/config.json", {
    testsDir: "tests/e2e/{runId}",
    webServer: {
      command: 'node -e "setTimeout(() => {}, 1000)"',
      url: "http://127.0.0.1:3000",
    },
  });
  await writeJson(repo, "package.json", {
    devDependencies: { "@playwright/test": "1" },
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
  const codex = await makeFakeCodex();
  const log = join(await makeTempDir(), "codex.log");
  await runCli(
    [
      "run",
      "--repo",
      repo,
      "--range",
      "HEAD~1..HEAD",
      "--generate",
      "--unit-command",
      unitCommand,
      "--playwright-command",
      playwrightCommand,
    ],
    { env: { PATH: prependPath(codex), CODEX_INVOCATION_LOG: log } },
  );
  const [runId] = await readdir(join(repo, ".changeforge/runs"));
  return { repo, runId, log };
}

describe("resumable commands", () => {
  test("inspects, executes without Codex, and idempotently applies a generate-only run", async () => {
    const { repo, runId, log } = await generatedRun();
    const run = join(repo, ".changeforge/runs", runId);
    await expectCompacted(run);

    const inspected = await runCli([
      "inspect",
      "--repo",
      repo,
      "--run",
      runId,
      "--json",
    ]);
    const view = JSON.parse(inspected.stdout);
    expect(view.manifest.runId).toBe(runId);
    expect(view.generatedPaths).toEqual([
      `tests/e2e/${runId}/test-edge-cases.spec.ts`,
    ]);
    expect(view.findings.total).toBe(1);
    expect(view.artifacts.overlay.sha256).toMatch(/^[a-f0-9]{64}$/);

    const before = await readFile(log, "utf8");
    const executed = await runCli(["execute", "--repo", repo, "--run", runId], {
      env: { PATH: process.env.PATH, CODEX_INVOCATION_LOG: log },
    });
    expect(JSON.parse(executed.stdout).status).toBe("passed");
    await expect(readFile(log, "utf8")).resolves.toBe(before);
    await expectCompacted(run);

    const manifest = JSON.parse(
      await readFile(join(run, "run-manifest.v1.json"), "utf8"),
    );
    expect(manifest.phases.execute.status).toBe("completed");
    expect(manifest.artifacts.summary.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifacts.snapshot.sha256).toBe(
      manifest.resolved.changeSha256,
    );
    for (const name of [
      "snapshot",
      "findings",
      "overlay",
      "summary",
      "patch",
      "generatedFiles",
    ]) {
      expect(manifest.artifacts[name].path).toMatch(
        new RegExp(`^artifacts/immutable/${name}/[a-f0-9]{64}\\.blob$`),
      );
    }

    const first = await runCli(["apply", "--repo", repo, "--run", runId]);
    expect(first.stdout).toContain('"status": "applied"');
    const second = await runCli(["apply", "--repo", repo, "--run", runId]);
    expect(second.stdout).toContain('"status": "already-applied"');
    await expectCompacted(run);
    const appliedManifest = JSON.parse(
      await readFile(join(run, "run-manifest.v1.json"), "utf8"),
    );
    expect(appliedManifest.phases.apply.status).toBe("completed");
    expect(appliedManifest.status).toBe("passed");
    await expect(
      readFile(
        join(repo, `tests/e2e/${runId}/test-edge-cases.spec.ts`),
        "utf8",
      ),
    ).resolves.toContain("fake generated edge case");
  });

  test("replays the exact dirty working-tree snapshot after checkout drift", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeJson(repo, "package.json", {});
    await writeFile(join(repo, "src.js"), "base\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "captured dirty bytes\n");
    const codex = await makeFakeCodex();
    const command =
      "node -e \"process.exit(require('fs').readFileSync('src.js','utf8') === 'captured dirty bytes\\n' ? 0 : 9)\"";
    await runCli(
      [
        "run",
        "--repo",
        repo,
        "--working-tree",
        "--no-playwright",
        "--unit-command",
        command,
      ],
      { env: { PATH: prependPath(codex) } },
    );
    const [runId] = await readdir(join(repo, ".changeforge/runs"));
    await writeFile(join(repo, "src.js"), "later checkout drift\n");

    const result = await runCli(["execute", "--repo", repo, "--run", runId]);

    expect(JSON.parse(result.stdout).status).toBe("passed");
    await expect(readFile(join(repo, "src.js"), "utf8")).resolves.toBe(
      "later checkout drift\n",
    );
  });

  test("rejects tampered artifacts and changed apply sources", async () => {
    const tampered = await generatedRun();
    await runCli(["execute", "--repo", tampered.repo, "--run", tampered.runId]);
    const tamperedManifest = await loadRunManifest(
      tampered.repo,
      tampered.runId,
    );
    const overlay = join(
      tampered.repo,
      ".changeforge/runs",
      tampered.runId,
      tamperedManifest.artifacts.overlay.path,
    );
    await writeFile(overlay, "{}\n");
    const inspect = await runCliResult([
      "inspect",
      "--repo",
      tampered.repo,
      "--run",
      tampered.runId,
      "--json",
    ]);
    expect(inspect.exitCode).toBe(1);
    const torn = JSON.parse(inspect.stdout);
    expect(torn.artifacts.snapshot.sha256).toBe(
      torn.manifest.resolved.changeSha256,
    );
    expect(torn.integrityErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact: "overlay",
          message: expect.stringMatching(/integrity/i),
        }),
      ]),
    );
    const idempotent = await runCliResult([
      "execute",
      "--repo",
      tampered.repo,
      "--run",
      tampered.runId,
    ]);
    expect(idempotent.exitCode).toBe(1);
    expect(idempotent.stderr).toMatch(/integrity/i);

    const changed = await generatedRun();
    const generated = join(
      changed.repo,
      `tests/e2e/${changed.runId}/test-edge-cases.spec.ts`,
    );
    await mkdir(join(generated, ".."), { recursive: true });
    await writeFile(generated, "conflicting local content\n");
    const conflict = await runCliResult([
      "apply",
      "--repo",
      changed.repo,
      "--run",
      changed.runId,
      "--force",
    ]);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toMatch(/mixed|changed/i);
    await unlink(generated);
    await writeFile(join(changed.repo, "later.txt"), "later\n");
    await runCli(["run", "git", "-C", changed.repo, "add", "later.txt"], {
      cwd: changed.repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", changed.repo, "commit", "-m", "later"], {
      cwd: changed.repo,
      passthrough: true,
    });
    const apply = await runCliResult([
      "apply",
      "--repo",
      changed.repo,
      "--run",
      changed.runId,
    ]);
    expect(apply.exitCode).toBe(1);
    expect(apply.stderr).toMatch(/HEAD no longer matches/i);
  }, 60_000);

  test("inspects a failed run using every artifact that survived", async () => {
    const repo = await makeGitRepo();
    await runCli(["init", "--repo", repo]);
    await writeFile(join(repo, "src.js"), "base\n");
    await runCli(["run", "git", "-C", repo, "add", "."], {
      cwd: repo,
      passthrough: true,
    });
    await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
      cwd: repo,
      passthrough: true,
    });
    await writeFile(join(repo, "src.js"), "dirty\n");
    const codex = await makeFailingCodex();
    await expect(
      runCli(["run", "--repo", repo, "--working-tree"], {
        env: { PATH: prependPath(codex) },
      }),
    ).rejects.toThrow();
    const [runId] = await readdir(join(repo, ".changeforge/runs"));

    const inspected = JSON.parse(
      (await runCli(["inspect", "--repo", repo, "--run", runId, "--json"]))
        .stdout,
    );

    expect(inspected.manifest.status).toBe("failed");
    expect(inspected.manifest.phases.review.status).toBe("failed");
    expect(inspected.summary.status).toBe("failed");
    expect(inspected.artifacts.snapshot.sha256).toBe(
      inspected.manifest.resolved.changeSha256,
    );
    expect(inspected.findings.total).toBe(0);
    const execute = await runCliResult([
      "execute",
      "--repo",
      repo,
      "--run",
      runId,
    ]);
    expect(execute.exitCode).toBe(1);
    expect(execute.stderr).toMatch(/requires completed.*review/i);
    expect((await loadRunManifest(repo, runId)).phases.execute.status).toBe(
      "pending",
    );
  });

  test("force recovers killed execute and crash-after-write apply attempts", async () => {
    const { repo, runId } = await generatedRun();
    let manifest = await loadRunManifest(repo, runId);
    manifest = setPhase(manifest, "execute", "running");
    await saveRunManifest(repo, manifest);

    const blocked = await runCliResult([
      "execute",
      "--repo",
      repo,
      "--run",
      runId,
    ]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toMatch(/in progress/i);
    await runCli(["execute", "--repo", repo, "--run", runId, "--force"]);
    manifest = await loadRunManifest(repo, runId);
    expect(manifest.phases.execute).toMatchObject({
      status: "completed",
      attempts: 2,
    });

    const overlay = JSON.parse(
      await readFile(
        join(repo, ".changeforge/runs", runId, manifest.artifacts.overlay.path),
        "utf8",
      ),
    );
    await applyGeneratedOverlay(repo, overlay);
    manifest = setPhase(manifest, "apply", "running");
    await saveRunManifest(repo, manifest);

    const applyBlocked = await runCliResult([
      "apply",
      "--repo",
      repo,
      "--run",
      runId,
    ]);
    expect(applyBlocked.exitCode).toBe(1);
    expect(applyBlocked.stderr).toMatch(/in progress/i);
    const recovered = await runCli([
      "apply",
      "--repo",
      repo,
      "--run",
      runId,
      "--force",
    ]);
    expect(recovered.stdout).toContain("already-applied");
    manifest = await loadRunManifest(repo, runId);
    expect(manifest.phases.apply).toMatchObject({
      status: "completed",
      attempts: 2,
    });
    expect(manifest.status).toBe("passed");
  });

  test("rejects project-command sidecar mutation without replacing frozen evidence", async () => {
    const command =
      "node -e \"require('fs').writeFileSync(process.env.CHANGEFORGE_TEST_FILE, 'mutated')\" {testFile}";
    const { repo, runId } = await generatedRun(command);
    const before = await loadRunManifest(repo, runId);
    const frozen = await readFile(
      join(repo, ".changeforge/runs", runId, before.artifacts.overlay.path),
      "utf8",
    );

    const result = await runCliResult([
      "execute",
      "--repo",
      repo,
      "--run",
      runId,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/generated overlay|generated.*changed/i);
    const after = await loadRunManifest(repo, runId);
    expect(after.artifacts.overlay).toEqual(before.artifacts.overlay);
    await expect(
      readFile(
        join(repo, ".changeforge/runs", runId, after.artifacts.overlay.path),
        "utf8",
      ),
    ).resolves.toBe(frozen);
    const error = JSON.parse(
      await readFile(
        join(
          repo,
          ".changeforge/runs",
          runId,
          after.artifacts.executeError.path,
        ),
        "utf8",
      ),
    );
    expect(error).toMatchObject({
      schemaVersion: "1.0",
      phase: "execute",
      error: { code: "GENERATED_OVERLAY_CONFLICT" },
    });
    await expect(
      readFile(
        join(repo, "changeforge", runId, "test-edge-cases.spec.ts"),
        "utf8",
      ),
    ).resolves.toContain("fake generated edge case");
  });

  test("rejects project source mutation even when the command exits zero", async () => {
    const unit =
      "node -e \"require('fs').writeFileSync('src.js', 'mutated\\n')\"";
    const { repo, runId } = await generatedRun(undefined, unit);

    const result = await runCliResult([
      "execute",
      "--repo",
      repo,
      "--run",
      runId,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/project inputs changed/i);
    const manifest = await loadRunManifest(repo, runId);
    const error = JSON.parse(
      await readFile(
        join(
          repo,
          ".changeforge/runs",
          runId,
          manifest.artifacts.executeError.path,
        ),
        "utf8",
      ),
    );
    expect(error.error.code).toBe("VERIFICATION_INPUT_MUTATED");
  });
});
