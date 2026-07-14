import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadRunManifest } from "../../src/core/run-store.js";
import { runCli } from "../utils/cli.js";
import {
  makeFakeCodex,
  makeGitRepo,
  makeTempDir,
  prependPath,
  writeJson,
} from "../utils/fs.js";

describe("differential run lifecycle", () => {
  test("proves generated coverage against base and head in one shot", async () => {
    const fixture = await setup();

    const result = await runCli(
      [
        "run",
        "--repo",
        fixture.repo,
        "--range",
        "HEAD~1..HEAD",
        "--generate",
        "--execute",
        "--differential",
        "--no-unit",
      ],
      { env: fixture.env },
    );

    expect(result.exitCode).toBe(0);
    const [runId] = await readdir(join(fixture.repo, ".changeforge/runs"));
    const manifest = await loadRunManifest(fixture.repo, runId);
    const inspected = await runCli([
      "inspect",
      "--repo",
      fixture.repo,
      "--run",
      runId,
      "--json",
    ]);
    const summary = JSON.parse(inspected.stdout).summary;
    expect(summary).toMatchObject({
      status: "passed",
      differential: {
        schemaVersion: "1.0",
        classification: "regression-proof",
      },
    });
    expect(manifest.plan.differential).toBe(true);
    expect(manifest.capabilities.differential).toBe(true);
    expect(manifest.phases.differential.status).toBe("completed");
    expect(manifest.artifacts.differential.path).toMatch(
      /^artifacts\/immutable\/differential\/[a-f0-9]{64}\.blob$/,
    );
    const artifact = JSON.parse(
      await readFile(
        join(
          fixture.repo,
          ".changeforge/runs",
          runId,
          manifest.artifacts.differential.path,
        ),
        "utf8",
      ),
    );
    expect(artifact).toMatchObject({
      schemaVersion: "1.0",
      generatedTest: {
        path: expect.stringMatching(/test-edge-cases\.spec\.ts$/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      result: {
        classification: "regression-proof",
        base: { outcome: "failed" },
        head: { outcome: "passed" },
      },
    });
    await expectSameGeneratedBytes(fixture.callLog);
  });

  test("resumes a planned differential without invoking Codex again", async () => {
    const fixture = await setup();
    await runCli(
      [
        "run",
        "--repo",
        fixture.repo,
        "--range",
        "HEAD~1..HEAD",
        "--generate",
        "--differential",
        "--no-unit",
      ],
      { env: fixture.env },
    );
    const [runId] = await readdir(join(fixture.repo, ".changeforge/runs"));
    const codexBefore = await readFile(fixture.codexLog, "utf8");
    const inspected = JSON.parse(
      (
        await runCli([
          "inspect",
          "--repo",
          fixture.repo,
          "--run",
          runId,
          "--json",
        ])
      ).stdout,
    );
    expect(inspected.manifest.plan.differential).toBe(true);
    expect(inspected.manifest.phases.differential.status).toBe("skipped");

    const resumed = await runCli(
      ["execute", "--repo", fixture.repo, "--run", runId],
      { env: fixture.env },
    );

    expect(JSON.parse(resumed.stdout)).toMatchObject({
      status: "passed",
      differential: { classification: "regression-proof" },
    });
    await expect(readFile(fixture.codexLog, "utf8")).resolves.toBe(codexBefore);
    expect(
      (await loadRunManifest(fixture.repo, runId)).phases.differential.status,
    ).toBe("completed");
  });
});

async function setup() {
  const repo = await makeGitRepo();
  await runCli(["init", "--repo", repo]);
  await writeJson(repo, ".changeforge/config.json", {
    testsDir: "tests/e2e/{runId}",
    webServer: { command: "node server.js", url: "http://127.0.0.1:3000" },
  });
  await writeJson(repo, "package.json", {
    devDependencies: { "@playwright/test": "1" },
  });
  await mkdir(join(repo, "node_modules"));
  await writeFile(join(repo, "src.js"), "base\n");
  await runCli(["run", "git", "-C", repo, "add", "."], {
    cwd: repo,
    passthrough: true,
  });
  await runCli(["run", "git", "-C", repo, "commit", "-m", "base"], {
    cwd: repo,
    passthrough: true,
  });
  await writeFile(join(repo, "src.js"), "head\n");
  await runCli(["run", "git", "-C", repo, "commit", "-am", "change"], {
    cwd: repo,
    passthrough: true,
  });
  const [codex, npm, state] = await Promise.all([
    makeFakeCodex(),
    makeDifferentialNpm(),
    makeTempDir(),
  ]);
  const codexLog = join(state, "codex.log");
  const callLog = join(state, "npm.jsonl");
  const env = {
    ...process.env,
    PATH: prependPath(npm, { ...process.env, PATH: prependPath(codex) }),
    CODEX_INVOCATION_LOG: codexLog,
    DIFFERENTIAL_CALL_LOG: callLog,
  };
  return { repo, codexLog, callLog, env };
}

async function makeDifferentialNpm() {
  const dir = await makeTempDir();
  const source = `
const fs = require("fs");
const args = process.argv.slice(2);
const differential = args.includes("--reporter=json");
const target = differential
  ? args.find(arg => arg.endsWith("$") && arg.includes("spec")).slice(0, -1).replace(/\\\\(.)/g, "$1")
  : args[args.indexOf("test") + 1];
const revision = fs.readFileSync("src.js", "utf8").trim();
const generated = fs.readFileSync(target, "utf8");
fs.appendFileSync(process.env.DIFFERENTIAL_CALL_LOG, JSON.stringify({ args, revision, generated, differential }) + "\\n");
if (!differential) process.exit(0);
const failed = revision === "base" && !process.env.DIFFERENTIAL_BASE_PASSES;
const error = { message: "generated assertion failed", location: { file: target, line: 3, column: 1 } };
process.stdout.write(JSON.stringify({ errors: [], suites: [{ specs: [{ file: target, tests: [{
  expectedStatus: "passed", status: failed ? "unexpected" : "expected",
  results: [{ status: failed ? "failed" : "passed", retry: 0, ...(failed ? { error } : {}) }]
}]}] }] }));
process.exit(failed ? 1 : 0);
`;
  await writeFile(join(dir, "npm"), `#!/usr/bin/env node\n${source}`);
  await chmod(join(dir, "npm"), 0o755);
  await writeFile(join(dir, "npm.cjs"), source);
  await writeFile(join(dir, "npm.cmd"), '@node "%~dp0npm.cjs" %*\r\n');
  return dir;
}

async function expectSameGeneratedBytes(log: string) {
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const differential = calls.filter((call) => call.differential);
  expect(differential.map((call) => call.revision)).toEqual(["base", "head"]);
  expect(differential).toHaveLength(2);
  expect(differential[0].generated).toBe(differential[1].generated);
}
