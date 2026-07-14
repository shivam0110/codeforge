import path from "node:path";
import { randomUUID } from "node:crypto";
import { slug } from "../utils/text.js";
import type { ChangeInput } from "./types.js";
import { ChangeForgeError } from "./errors.js";

export function buildRunId(input: ChangeInput, date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  const suffix = input.kind === "working-tree" ? "working-tree" : slug(input.value);
  return `${stamp}-${suffix}-${randomUUID().slice(0, 8)}`;
}

export function runDir(root: string, runId: string) {
  return path.join(root, ".changeforge", "runs", runId);
}

export function reportDir(root: string, docsDir: string, runId: string) {
  return path.join(resolveContainedPath(root, docsDir, "docsDir"), runId);
}

export function testsDir(root: string, testsRoot: string, runId: string) {
  return resolveTemplatedPath(root, testsRoot, runId);
}

export function optionalRunPath(root: string, template: string | null, runId: string) {
  return template ? resolveTemplatedPath(root, template, runId) : null;
}

function resolveTemplatedPath(root: string, value: string, runId: string) {
  return resolveContainedPath(root, value.replaceAll("{runId}", runId), "configured path");
}

export function resolveContainedPath(root: string, value: string, label: string) {
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new ChangeForgeError(`${label} must be a relative path.`, "PATH_OUTSIDE_REPO");
  }
  const base = path.resolve(root);
  const target = path.resolve(base, value);
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new ChangeForgeError(`${label} must stay inside the repository.`, "PATH_OUTSIDE_REPO");
  }
  return target;
}
