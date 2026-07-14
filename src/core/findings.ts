import { createHash } from "node:crypto";
import path from "node:path";
import { ChangeForgeError } from "./errors.js";

export const FINDINGS_SCHEMA_VERSION = "1.0" as const;
export const MAX_REVIEW_OUTPUT_BYTES = 1024 * 1024;
export const MAX_FINDINGS = 200;

export type FindingSeverity = "low" | "medium" | "high" | "critical";

export interface FindingV1 {
  id: string;
  title: string;
  severity: FindingSeverity;
  confidence: number;
  file: string | null;
  line: number | null;
  evidence: string;
  suggestedValidation: string;
}

export interface FindingsDocumentV1 {
  schemaVersion: typeof FINDINGS_SCHEMA_VERSION;
  findings: FindingV1[];
}

export interface FindingsArtifactsV1 {
  document: FindingsDocumentV1;
  artifact: string;
  report: string;
}

type NormalizedFindingV1 = Omit<FindingV1, "id">;

const documentKeys = ["findings", "schemaVersion"];
const findingKeys = ["confidence", "evidence", "file", "line", "severity", "suggestedValidation", "title"];
const severities = new Set<FindingSeverity>(["low", "medium", "high", "critical"]);

export function parseFindingsV1(output: string, repoRoot: string): FindingsDocumentV1 {
  if (Buffer.byteLength(output) > MAX_REVIEW_OUTPUT_BYTES) invalid("Review output exceeds 1 MiB.");
  const value = parseJson(extractJson(output));
  if (!record(value) || !exactKeys(value, documentKeys)) invalid("Review document keys are invalid.");
  if (value.schemaVersion !== FINDINGS_SCHEMA_VERSION) invalid("Review schemaVersion must be 1.0.");
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) invalid("Review findings must contain at most 200 items.");

  const findings = identifyFindings(value.findings.map((item, index) => normalizeFinding(item, repoRoot, index)));
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: FINDINGS_SCHEMA_VERSION, findings };
}

export function renderFindingsMarkdown(document: FindingsDocumentV1) {
  const lines = [
    "# ChangeForge Findings",
    "",
    `Schema: ${inline(document.schemaVersion)}`,
    `Total: ${document.findings.length}`,
    ""
  ];
  if (!document.findings.length) return `${lines.join("\n")}No findings.\n`;
  for (const finding of document.findings) {
    const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "Not provided";
    lines.push(
      `## ${inline(finding.id)} — ${inline(finding.title)}`,
      "",
      `- Severity: ${inline(finding.severity)}`,
      `- Confidence: ${inline(finding.confidence)}`,
      `- Location: ${inline(location)}`,
      "",
      "### Evidence",
      "",
      quote(finding.evidence),
      "",
      "### Suggested validation",
      "",
      quote(finding.suggestedValidation),
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function normalizeFinding(value: unknown, repoRoot: string, index: number): NormalizedFindingV1 {
  if (!record(value) || !exactKeys(value, findingKeys)) invalid(`Finding ${index + 1} keys are invalid.`);
  const title = boundedString(value.title, "title", 300, true);
  const evidence = boundedString(value.evidence, "evidence", 20_000);
  const suggestedValidation = boundedString(value.suggestedValidation, "suggestedValidation", 10_000);
  if (typeof value.severity !== "string" || !severities.has(value.severity as FindingSeverity)) invalid(`Finding ${index + 1} severity is invalid.`);
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    invalid(`Finding ${index + 1} confidence is invalid.`);
  }
  const file = normalizeFile(value.file, repoRoot, index);
  const line = normalizeLine(value.line, index);
  if (!file && line !== null) invalid(`Finding ${index + 1} cannot have a line without a file.`);
  return {
    title,
    severity: value.severity as FindingSeverity,
    confidence: value.confidence,
    file,
    line,
    evidence,
    suggestedValidation
  };
}

function identifyFindings(findings: NormalizedFindingV1[]): FindingV1[] {
  const groups = new Map<string, NormalizedFindingV1[]>();
  for (const finding of findings) {
    const key = identity(finding.file, finding.evidence);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups].flatMap(([key, group]) => {
    if (group.length === 1) return [{ ...group[0]!, id: findingId(key) }];
    const identified = group.map((finding) => ({ ...finding, id: findingId(collisionIdentity(key, finding)) }));
    if (new Set(identified.map(({ id }) => id)).size !== identified.length) invalid("Review contains indistinguishable duplicate findings.");
    return identified;
  });
}

function normalizeFile(value: unknown, root: string, index: number) {
  if (value === null) return null;
  const file = boundedString(value, "file", 4096, true).replaceAll("\\", "/");
  if (file.includes("\0") || /^[a-z][a-z\d+.-]*:\/\//i.test(file)) invalid(`Finding ${index + 1} file is invalid.`);
  if (path.win32.isAbsolute(file) && !path.isAbsolute(file)) invalid(`Finding ${index + 1} file escapes the repository.`);
  const base = path.resolve(root);
  const target = path.isAbsolute(file) ? path.resolve(file) : path.resolve(base, ...file.split("/"));
  const relative = path.relative(base, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    invalid(`Finding ${index + 1} file must be a repository-relative file.`);
  }
  return relative.split(path.sep).join("/");
}

function normalizeLine(value: unknown, index: number) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000_000) invalid(`Finding ${index + 1} line is invalid.`);
  return value as number;
}

function identity(file: string | null, evidence: string) {
  return `changeforge.finding.v1\0${file ?? ""}\0${canonical(evidence)}`;
}

function collisionIdentity(base: string, finding: NormalizedFindingV1) {
  return `changeforge.finding.v1.collision\0${base}\0${finding.line ?? ""}\0${canonical(finding.title)}\0${canonical(finding.suggestedValidation)}`;
}

function findingId(value: string) {
  const digest = createHash("sha256").update(value).digest("hex");
  return `CF1-${digest}`;
}

function canonical(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function extractJson(output: string) {
  const trimmed = output.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (trimmed.startsWith("```") && !fenced) invalid("Review output must be one JSON document.");
  return fenced?.[1] ?? trimmed;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalid("Review output is not valid JSON.");
  }
}

function boundedString(value: unknown, name: string, max: number, singleLine = false) {
  if (typeof value !== "string") invalid(`Finding ${name} must be a string.`);
  let normalized = value.normalize("NFC");
  if (!singleLine) normalized = normalized.replace(/\r\n?/g, "\n");
  const unsafe = hasUnsafeControl(normalized, !singleLine);
  normalized = normalized.trim();
  if (!normalized || normalized.length > max || unsafe) {
    invalid(`Finding ${name} is invalid.`);
  }
  return normalized;
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inline(value: unknown) {
  return sanitizeControls(String(value), false)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/([\\`*_{}[\]()#+.!|])/g, "\\$1");
}

function quote(value: unknown) {
  return sanitizeControls(String(value).replace(/\r\n?/g, "\n"), true)
    .split("\n").map((line) => `> ${inlineMultiline(line)}`).join("\n");
}

function inlineMultiline(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/([\\`*_{}[\]()#+.!|])/g, "\\$1");
}

function hasUnsafeControl(value: string, multiline: boolean) {
  return [...value].some((character) => unsafeControl(character.codePointAt(0)!, multiline));
}

function sanitizeControls(value: string, multiline: boolean) {
  return [...value].map((character) => unsafeControl(character.codePointAt(0)!, multiline) ? "�" : character).join("");
}

function unsafeControl(code: number, multiline: boolean) {
  const allowed = multiline && (code === 9 || code === 10);
  return !allowed && (code <= 31 || code >= 127 && code <= 159);
}

function invalid(message: string): never {
  throw new ChangeForgeError(message, "REVIEW_OUTPUT_INVALID");
}
