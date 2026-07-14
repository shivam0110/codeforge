import path from "node:path";
import type { CodexConfig, RunContext } from "../core/types.js";
import type { CollectedContext } from "../pipeline/collect-context.js";

type PromptConfig = Partial<Pick<CodexConfig, "reviewSystemPrompt" | "testGenerationSystemPrompt">> & {
  preferStableLocators?: boolean;
  webServerUrl?: string | null;
};

export function buildReviewPrompt(context: RunContext, collected: Pick<CollectedContext, "report">, config: PromptConfig = {}) {
  const contextDir = path.join(context.runDir, "context");
  return `You are ChangeForge, a read-only change reviewer.

Do not modify files in this phase.
Do not run shell commands.
Review only the supplied deterministic report and artifact paths.
Do not invent behavior that is not implied by the diff.
Prefer existing project conventions.
${configuredInstructions("Configured review instructions", config.reviewSystemPrompt)}

Run:
- id: ${context.runId}
- input: ${JSON.stringify(context.input)}
- diff patch: ${path.join(contextDir, "diff.patch")}
- diff stat: ${path.join(contextDir, "diff-stat.txt")}
- name status: ${path.join(contextDir, "name-status.txt")}
- file snapshots: ${path.join(contextDir, "file-snapshots.json")}
- run dir: ${context.runDir}
- public report dir: ${context.reportDir}

Use this deterministic report as your primary input:

${collected.report}

Return JSON only, with no prose or Markdown fences, using exactly this schema:
{
  "schemaVersion": "1.0",
  "findings": [
    {
      "title": "concise problem statement",
      "severity": "low | medium | high | critical",
      "confidence": 0.0,
      "file": "repo-relative/posix/path.ts or null",
      "line": 1,
      "evidence": "specific evidence grounded in the supplied artifacts",
      "suggestedValidation": "a concrete check or test"
    }
  ]
}

Use null for both file and line when no source location is available.
Do not include an id; ChangeForge derives stable finding IDs locally.
Return at most 200 findings. Return an empty findings array when there are no findings.
`;
}

export function buildPlaywrightPrompt(context: RunContext, collected: Pick<CollectedContext, "report">, review: string, config: PromptConfig = {}) {
  return `You are ChangeForge, generating Playwright coverage for a real repository.
${configuredInstructions("Configured test-generation instructions", config.testGenerationSystemPrompt)}

Generated Playwright tests directory:
${context.testsDir}

${e2eTarget(context)}

${generatedSpecTarget(context)}

Test focus:
${testFocus(context)}

Review:
${review}

Deterministic review input:
${collected.report}

Rules:
- Do not run shell commands, tests, browsers, formatters, or package managers. Write the spec and stop.
- Only create or update Playwright tests in this generated sidecar. Do not create Playwright config files.
- Only write this generated spec file; it is the sole output: ${context.generatedTestFile}
- The configured e2e file is reference/config only and must not be edited.
- Do not add login, session-token, database, or app-startup setup.
- For generated sidecars, import only @playwright/test.
- For generated sidecars, do not import app modules, helpers, network clients, or setup modules.
- Always use page.goto with the configured base URL and make a nonconstant assertion derived from the page.${webServerRule(config.webServerUrl)}
- Do not use the request fixture, Playwright request API, page.context().request, or direct network APIs.
- Do not use process execution, environment access, filesystem access, eval, dynamic import, or require.
- Do not skip or mark tests fixme.
- Do not create unit tests.
- Do not write change documentation.
- Do not edit production code or any file other than the generated sidecar.
- Do not add external services.
- Do not remove existing tests.
- Do not weaken assertions.
- If app startup, auth, database, or seed data is unclear, document the gap instead of inventing credentials.
${locatorRule(config.preferStableLocators)}

Keep the generated file close to this policy-compliant shape:

import { test, expect } from "@playwright/test";

test("descriptive edge case", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
});

Replace the route, locator, name, and assertion with repository-grounded behavior. Do not add top-level helpers or placeholder assertions.

Generate only the edge-case spec coverage now. Keep changes minimal and reviewable.
`;
}

function e2eTarget(context: RunContext) {
  if (!context.e2eTestFile) return "Existing configured e2e reference: none.";
  if (context.e2eTestFileExists) {
    return `Existing configured e2e reference (read-only):\n${context.e2eTestFile}\nThis file is reference/config only and must not be edited.`;
  }
  return `Configured e2e reference is not present:\n${context.e2eTestFile}`;
}

function generatedSpecTarget(context: RunContext) {
  return `Generated edge-case spec file:\n${context.generatedTestFile}`;
}

function testFocus(context: RunContext) {
  if (context.testFocus === "full") return "Full Playwright coverage is allowed by config.";
  return "Edge-case coverage only. Prefer boundary, failure, permission, empty-state, and regression paths over duplicating obvious happy paths.";
}

function configuredInstructions(title: string, value?: string | null) {
  const text = value?.trim();
  return text ? `\n${title}:\n${text}\n` : "";
}

function webServerRule(url?: string | null) {
  return url ? `\n- Configured web server URL: ${url}` : "";
}

function locatorRule(preferred?: boolean) {
  return preferred ? "- Prefer getByRole, getByLabel, and stable visible text. Use test ids only when already used by the repo." : "";
}
