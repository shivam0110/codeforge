import path from "node:path";
import { CodexCliAdapter, readCodexOutput } from "../codex/cli-adapter.js";
import { buildPlaywrightPrompt } from "../codex/prompts.js";
import { ChangeForgeError } from "../core/errors.js";
import type { ChangeForgeConfig, CodexResult, RunContext } from "../core/types.js";
import { writeTextContained } from "../utils/fs.js";
import type { CollectedContext } from "./collect-context.js";
import { prepareGenerationWorkspace } from "./generation-workspace.js";
import { formatSpecPolicyIssues } from "./spec-policy.js";

type GenerationOptions = { generate?: boolean; playwright?: boolean; model?: string };

export type PlaywrightGenerationResult =
  | { status: "skipped"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "executed"; reason: string }
  | { status: "generated"; targetFile: string; result: CodexResult };

export async function generatePlaywrightCoverage(
  context: RunContext,
  collected: CollectedContext,
  reviewFile: string,
  config: ChangeForgeConfig,
  options: GenerationOptions
): Promise<PlaywrightGenerationResult> {
  if (options.playwright === false || !config.playwright.enabled) {
    return { status: "skipped", reason: "Playwright generation is disabled." };
  }
  if (!collected.project.hasPlaywright) return { status: "unavailable", reason: "Playwright is not installed." };
  if (!context.e2eTestFileExists && (!config.webServer.command || !config.webServer.url)) {
    return { status: "unavailable", reason: "No configured Playwright target or web server." };
  }
  if (!options.generate) return { status: "skipped", reason: "Generation was not authorized." };

  const workspace = await prepareGenerationWorkspace(context);
  const review = await readCodexOutput(context.originalRoot, reviewFile);
  const promptConfig = {
    ...config.codex,
    preferStableLocators: config.playwright.preferStableLocators,
    webServerUrl: config.webServer.url
  };
  const prompt = buildPlaywrightPrompt(workspace.context, collected, review, promptConfig);
  const promptFile = path.join(context.runDir, "prompts/playwright.prompt.md");
  await writeTextContained(context.originalRoot, promptFile, prompt);
  const result = await runCodex(context, workspace.cwd, prompt, "playwright", options.model, config);
  const issues = await workspace.policyIssues({ webServerUrl: config.webServer.url });
  if (issues.length) {
    const message = formatSpecPolicyIssues(issues);
    await writeTextContained(context.originalRoot, path.join(context.runDir, "logs/generated-spec-policy.log"), message);
    throw new ChangeForgeError(message, "GENERATED_SPEC_POLICY");
  }

  await workspace.finalize({ webServerUrl: config.webServer.url });
  return { status: "generated", targetFile: workspace.sourceTargetFile, result };
}

function runCodex(
  context: RunContext,
  cwd: string,
  prompt: string,
  name: string,
  model: string | undefined,
  config: ChangeForgeConfig
) {
  return new CodexCliAdapter().runTask({
    cwd,
    artifactRoot: context.originalRoot,
    prompt,
    sandbox: "workspace-write",
    outputFile: path.join(context.runDir, `codex/${name}.output.md`),
    model,
    reasoning: config.codex.reasoning,
    stream: config.codex.stream,
    ignoreRules: config.codex.ignoreRules,
    timeoutMs: config.codex.timeoutMs,
    logFile: path.join(context.runDir, `logs/codex-${name}.log`)
  });
}
