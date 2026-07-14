import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { buildPlaywrightPrompt } from "../../src/codex/prompts.js";
import { defaultConfig } from "../../src/core/config.js";
import { validateConfig } from "../../src/core/config-schema.js";
import type { RunContext } from "../../src/core/types.js";
import { prepareGenerationWorkspace } from "../../src/pipeline/generation-workspace.js";
import { makeTempDir } from "../utils/fs.js";

test("uses fast Codex reasoning by default", () => {
  expect(defaultConfig.codex.reasoning).toBe("low");
  expect("reviewDocPath" in defaultConfig).toBe(false);
});

test("migrates the retired high-reasoning default to low", () => {
  const legacy = {
    ...structuredClone(defaultConfig),
    repairAttempts: 1,
    allure: { enabled: true },
    reviewDocPath: "changeforge/{runId}/change-report.md",
    codex: { ...defaultConfig.codex, reasoning: "high" },
  };

  const migrated = validateConfig(legacy);
  expect(migrated.codex.reasoning).toBe("low");
  expect("reviewDocPath" in migrated).toBe(false);
});

test("generation prompt forbids execution and supplies a compliant shape", async () => {
  const context = await fixture();
  const prompt = buildPlaywrightPrompt(context, { report: "# report" }, "# review");

  expect(prompt).toContain("Do not run shell commands, tests, browsers, formatters, or package managers.");
  expect(prompt).toContain('import { test, expect } from "@playwright/test";');
  expect(prompt).toContain('await page.goto("/");');
});

test("configured sidecars are not validated as fallback coverage", async () => {
  const workspace = await prepareGenerationWorkspace(await fixture());
  await mkdir(path.dirname(workspace.targetFile), { recursive: true });
  await writeFile(
    workspace.targetFile,
    `import { test, expect } from "@playwright/test";
test("uses configured setup", async ({ page }) => {
  await expect(page.locator("main")).toBeVisible();
});
`,
  );

  await expect(workspace.policyIssues()).resolves.toEqual([]);
});

async function fixture(): Promise<RunContext> {
  const originalRoot = await makeTempDir();
  const workRoot = await makeTempDir();
  const testsDir = path.join(workRoot, "tests/generated/run-1");
  return {
    runId: "run-1",
    originalRoot,
    workRoot,
    runDir: path.join(originalRoot, ".changeforge/runs/run-1"),
    reportDir: path.join(originalRoot, "changeforge/run-1"),
    testsDir,
    generatedTestFile: path.join(testsDir, "edge.spec.ts"),
    e2eTestFile: path.join(workRoot, "tests/e2e/reference.spec.ts"),
    e2eTestFileExists: true,
    testFocus: "edge-cases",
    input: { kind: "working-tree" },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    generate: true,
    execute: true,
    allowSourceEdits: false,
  };
}
