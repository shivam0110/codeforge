import fs from "node:fs/promises";
import path from "node:path";
import { ChangeForgeError } from "../core/errors.js";
import type { RunContext } from "../core/types.js";
import { ensureDirContained, existsContained, readBufferContained, readTextContained, writeTextContained } from "../utils/fs.js";
import { formatSpecPolicyIssues, inspectGeneratedSpec, type SpecPolicyIssue } from "./spec-policy.js";

export type GenerationPolicyOptions = { webServerUrl?: string | null };

export type GenerationWorkspace = {
  cwd: string;
  context: RunContext;
  targetFile: string;
  sourceTargetFile: string;
  policyIssues(options?: GenerationPolicyOptions): Promise<SpecPolicyIssue[]>;
  finalize(options?: GenerationPolicyOptions): Promise<void>;
};

export async function prepareGenerationWorkspace(context: RunContext): Promise<GenerationWorkspace> {
  assertIsolated(context);
  const sourceTargetFile = context.generatedTestFile;
  assertInside(context.workRoot, sourceTargetFile);
  const cwd = path.join(context.workRoot, ".changeforge-runtime/generation");
  await ensureDirContained(context.workRoot, cwd);
  const stagedContext = mapContext(context, cwd);
  const stagedTarget = stagedContext.generatedTestFile;
  if (await existsContained(context.workRoot, sourceTargetFile)) {
    await writeTextContained(cwd, stagedTarget, await readBufferContained(context.workRoot, sourceTargetFile));
  }
  return workspace(context, stagedContext, stagedTarget, sourceTargetFile);
}

function assertIsolated(context: RunContext) {
  const original = path.resolve(context.originalRoot);
  const work = path.resolve(context.workRoot);
  const relative = path.relative(original, work);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new ChangeForgeError("Generation requires an external isolated sandbox.", "CODEX_WRITE_POLICY");
  }
}

function workspace(
  sourceContext: RunContext,
  stagedContext: RunContext,
  stagedTarget: string,
  sourceTarget: string
): GenerationWorkspace {
  const policyIssues = async (options: GenerationPolicyOptions = {}) => {
    if (!(await existsContained(stagedContext.workRoot, stagedTarget))) {
      return [{ rule: "missing-spec", detail: "Codex did not create the allowed Playwright target." }];
    }
    return inspectGeneratedSpec(await readTextContained(stagedContext.workRoot, stagedTarget), {
      fallback: !sourceContext.e2eTestFileExists,
      targetFile: sourceTarget,
      workRoot: sourceContext.workRoot,
      webServerUrl: options.webServerUrl
    });
  };
  return {
    cwd: stagedContext.workRoot,
    context: stagedContext,
    targetFile: stagedTarget,
    sourceTargetFile: sourceTarget,
    policyIssues,
    async finalize(options = {}) {
      await rejectUnexpectedFiles(stagedContext.workRoot, stagedTarget);
      const issues = await policyIssues(options);
      if (issues.length) throw new ChangeForgeError(formatSpecPolicyIssues(issues), "GENERATED_SPEC_POLICY");
      await writeTextContained(sourceContext.workRoot, sourceTarget, await readBufferContained(stagedContext.workRoot, stagedTarget));
    }
  };
}

function mapContext(context: RunContext, cwd: string): RunContext {
  const map = (value: string) => path.join(cwd, relativeInside(context.workRoot, value));
  return {
    ...context,
    workRoot: cwd,
    testsDir: map(context.testsDir),
    generatedTestFile: map(context.generatedTestFile),
    e2eTestFile: context.e2eTestFile
  };
}

async function rejectUnexpectedFiles(root: string, allowed: string) {
  for (const file of await files(root)) {
    if (path.resolve(file) !== path.resolve(allowed)) {
      throw new ChangeForgeError(`Codex wrote outside the allowed target: ${path.relative(root, file)}`, "CODEX_WRITE_POLICY");
    }
  }
}

async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ChangeForgeError(`Codex created a symlink: ${path.relative(root, full)}`, "CODEX_WRITE_POLICY");
    }
    if (entry.isDirectory()) found.push(...await files(full));
    else if (entry.isFile()) found.push(full);
    else throw new ChangeForgeError(`Codex created an unsupported file: ${path.relative(root, full)}`, "CODEX_WRITE_POLICY");
  }
  return found;
}

function relativeInside(root: string, target: string) {
  assertInside(root, target);
  return path.relative(path.resolve(root), path.resolve(target));
}

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ChangeForgeError("Generation target must be a file inside the isolated sandbox.", "CODEX_WRITE_POLICY");
  }
}
