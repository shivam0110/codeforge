import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../utils/cli.js";
import {
  makeFakeCodex,
  makeGitRepo,
  prependPath,
  writeJson,
} from "../utils/fs.js";

async function repoWithChange() {
  const repo = await makeGitRepo();
  await runCli(["init", "--repo", repo]);
  await writeJson(repo, "package.json", {
    dependencies: { local: "1" },
    scripts: {
      test: "node -e \"const fs=require('fs');process.exit(fs.readFileSync('node_modules/local/value','utf8')==='ready'&&fs.existsSync('node_modules/setup')?0:1)\"",
    },
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
  await mkdir(join(repo, "node_modules/local"), { recursive: true });
  await writeFile(join(repo, "node_modules/local/value"), "ready");
  return repo;
}

describe("dependency reuse", () => {
  test("links local dependencies and runs trusted setup before tests", async () => {
    const repo = await repoWithChange();
    const codex = await makeFakeCodex();
    const result = await runCli(
      [
        "run",
        "--repo",
        repo,
        "--range",
        "HEAD~1..HEAD",
        "--execute",
        "--setup-command",
        "node -e \"require('fs').writeFileSync('node_modules/setup','yes')\"",
        "--no-playwright",
      ],
      { env: { PATH: prependPath(codex) } },
    );

    expect(result.stdout).toContain('"status": "passed"');
    await expect(
      readFile(join(repo, "node_modules/setup"), "utf8"),
    ).resolves.toBe("yes");
  });

  test("reuses dependencies and the stored setup command when execution resumes", async () => {
    const repo = await repoWithChange();
    const codex = await makeFakeCodex();
    await writeJson(repo, ".changeforge/config.json", {
      setupCommand:
        "node -e \"require('fs').writeFileSync('node_modules/setup','yes')\"",
      playwright: { enabled: false },
    });
    await runCli(["run", "--repo", repo, "--range", "HEAD~1..HEAD"], {
      env: { PATH: prependPath(codex) },
    });
    const [runId] = await readdir(join(repo, ".changeforge/runs"));

    const result = await runCli(["execute", "--repo", repo, "--run", runId]);

    expect(result.stdout).toContain('"status": "passed"');
    await expect(
      readFile(join(repo, "node_modules/setup"), "utf8"),
    ).resolves.toBe("yes");
  });
});
