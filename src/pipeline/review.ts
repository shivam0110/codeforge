import path from "node:path";
import { CodexCliAdapter } from "../codex/cli-adapter.js";
import { buildReviewPrompt } from "../codex/prompts.js";
import { parseFindingsV1, renderFindingsMarkdown, type FindingsArtifactsV1 } from "../core/findings.js";
import type { ChangeForgeConfig, RunContext } from "../core/types.js";
import { readTextContained, writeJsonContained, writeTextContained } from "../utils/fs.js";
import type { CollectedContext } from "./collect-context.js";

export async function reviewChange(context: RunContext, collected: CollectedContext, model?: string, codex?: ChangeForgeConfig["codex"]) {
  const prompt = buildReviewPrompt(context, collected, codex);
  const promptFile = path.join(context.runDir, "prompts/review.prompt.md");
  const outputFile = path.join(context.runDir, "codex/review.output.txt");
  await writeTextContained(context.originalRoot, promptFile, prompt);
  const result = await new CodexCliAdapter().runTask({
    cwd: context.workRoot,
    artifactRoot: context.originalRoot,
    prompt,
    sandbox: "read-only",
    outputFile,
    model,
    reasoning: codex?.reasoning,
    stream: codex?.stream,
    ignoreRules: codex?.ignoreRules,
    timeoutMs: codex?.timeoutMs,
    logFile: path.join(context.runDir, "logs/codex-review.log")
  });
  const document = parseFindingsV1(await readTextContained(context.originalRoot, outputFile), context.originalRoot);
  const artifact = path.join(context.runDir, "artifacts/findings.v1.json");
  const report = path.join(context.reportDir, "code-review.md");
  await writeJsonContained(context.originalRoot, artifact, document);
  await writeTextContained(context.originalRoot, report, renderFindingsMarkdown(document));
  const findings: FindingsArtifactsV1 = { document, artifact, report };
  return { result, outputFile, findings };
}
