import path from "node:path";
import type { DiffContext, FileSnapshot, ProjectDetection, RunContext } from "../core/types.js";

export function buildChangeReport(context: RunContext, diff: DiffContext, project: ProjectDetection, snapshots: FileSnapshot[]) {
  return [
    "# ChangeForge Review Input",
    "",
    "## Run",
    "",
    `- Run ID: \`${context.runId}\``,
    `- Input: \`${inputLabel(context)}\``,
    `- Base SHA: \`${context.baseSha}\``,
    `- Head SHA: \`${context.headSha}\``,
    `- Original root: \`${context.originalRoot}\``,
    `- Work root: \`${context.workRoot}\``,
    "- External sandbox: `true`",
    `- Allow source edits: \`${context.allowSourceEdits}\``,
    `- Generation authorized: \`${context.generate}\``,
    `- Execution authorized: \`${context.execute}\``,
    "",
    "## Project",
    "",
    `- Package manager: \`${project.packageManager ?? "none"}\``,
    `- Has package.json: \`${project.hasPackageJson}\``,
    `- Playwright: \`${project.hasPlaywright}\``,
    `- Playwright config: \`${project.playwrightConfig ?? "none"}\``,
    "",
    "## Changed Files",
    "",
    "| Status | Path | Snapshot |",
    "|---|---|---|",
    ...snapshots.map((item) => `| ${item.status} | ${inlineCode(item.path)} | ${snapshotLabel(item)} |`),
    "",
    "## Diff Stat",
    "",
    "```text",
    diff.stat.trim(),
    "```",
    "",
    "## Commands",
    "",
    `- Unit: \`${project.suggestedUnitCommand ?? "not detected"}\``,
    `- Playwright: \`${project.suggestedPlaywrightCommand ?? "not detected"}\``,
    "",
    "## File Snapshots",
    "",
    ...snapshots.flatMap(snapshotSection),
    "",
    "## Raw Diff",
    "",
    "```diff",
    diff.patch.trim(),
    "```",
    ""
  ].join("\n");
}

function inputLabel(context: RunContext) {
  return context.input.kind === "working-tree" ? "working-tree" : `${context.input.kind} ${context.input.value}`;
}

function snapshotSection(snapshot: FileSnapshot) {
  if (snapshot.kind === "gitlink") {
    return [
      `### ${inlineCode(snapshot.path)}`,
      "",
      "_Git submodule/gitlink change._",
      "",
      `- Commit: \`${snapshot.oldSha ?? "unknown"}\` -> \`${snapshot.newSha ?? "unknown"}\``,
      snapshot.url ? `- URL: ${inlineCode(snapshot.url)}` : "",
      snapshot.branch ? `- Branch: ${inlineCode(snapshot.branch)}` : "",
      `- Initialized: \`${Boolean(snapshot.initialized)}\``,
      ""
    ].filter((line) => line !== "");
  }
  if (!snapshot.exists) return [`### ${inlineCode(snapshot.path)}`, "", "_No current file snapshot available._", ""];
  return [
    `### ${inlineCode(snapshot.path)}`,
    "",
    `\`\`\`${language(snapshot.path)}`,
    snapshot.content.trimEnd(),
    "```",
    snapshot.truncated ? "_Snapshot truncated._" : "",
    ""
  ].filter((line) => line !== "");
}

function inlineCode(value: string) {
  const text = value.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("|", "\\|");
  const width = Math.max(1, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1));
  const fence = "`".repeat(width);
  return `${fence}${text}${fence}`;
}

function snapshotLabel(snapshot: FileSnapshot) {
  if (snapshot.kind === "gitlink") return snapshot.initialized ? "submodule" : "submodule (not initialized)";
  return snapshot.exists ? "present" : "missing";
}

function language(filePath: string) {
  const ext = path.extname(filePath).slice(1);
  if (ext === "tsx" || ext === "ts") return "ts";
  if (ext === "jsx" || ext === "js" || ext === "mjs" || ext === "cjs") return "js";
  if (ext === "json") return "json";
  if (ext === "md") return "md";
  if (ext === "css") return "css";
  if (ext === "html") return "html";
  return "";
}
