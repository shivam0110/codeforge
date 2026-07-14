import { describe, expect, test } from "vitest";
import { join } from "node:path";
import {
  parseFindingsV1,
  renderFindingsMarkdown,
} from "../../src/core/findings.js";
import { makeTempDir } from "../utils/fs.js";

describe("structured findings v1", () => {
  test("parses, normalizes, identifies, and sorts findings", async () => {
    const root = await makeTempDir();
    const document = parseFindingsV1(
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [
          finding({ file: "./src\\value.ts", evidence: "  Missing guard.  " }),
          finding({
            file: join(root, "src/other.ts"),
            evidence: "Different evidence.",
          }),
        ],
      }),
      root,
    );

    expect(document.schemaVersion).toBe("1.0");
    expect(document.findings).toHaveLength(2);
    expect(document.findings.map(({ id }) => id)).toEqual(
      [...document.findings.map(({ id }) => id)].sort(),
    );
    expect(
      document.findings.every(({ id }) => /^CF1-[a-f0-9]{64}$/.test(id)),
    ).toBe(true);
    expect(document.findings.map(({ file }) => file).sort()).toEqual([
      "src/other.ts",
      "src/value.ts",
    ]);
    expect(
      document.findings.find(({ file }) => file === "src/value.ts")?.evidence,
    ).toBe("Missing guard.");
  });

  test("derives stable and case-sensitive finding ids", async () => {
    const root = await makeTempDir();
    const first = parseFindingsV1(
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [
          finding({
            title: "One",
            severity: "low",
            line: 2,
            evidence: "Missing   guard.",
          }),
        ],
      }),
      root,
    );
    const second = parseFindingsV1(
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [
          finding({
            title: "Two",
            severity: "critical",
            confidence: 0.1,
            line: 99,
            evidence: " Missing  guard. ",
          }),
        ],
      }),
      root,
    );

    expect(first.findings[0]?.id).toBe(second.findings[0]?.id);
    const upper = parseFindingsV1(
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [finding({ evidence: "value === Foo" })],
      }),
      root,
    );
    const lower = parseFindingsV1(
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [finding({ evidence: "value === foo" })],
      }),
      root,
    );

    expect(upper.findings[0]?.id).not.toBe(lower.findings[0]?.id);
  });

  test("disambiguates legitimate same-file same-evidence findings independent of input order", async () => {
    const root = await makeTempDir();
    const first = finding({
      title: "Missing lower bound",
      line: 12,
      suggestedValidation: "Test zero.",
    });
    const second = finding({
      title: "Missing upper bound",
      line: 20,
      suggestedValidation: "Test the maximum.",
    });
    const forward = parseFindingsV1(
      JSON.stringify({ schemaVersion: "1.0", findings: [first, second] }),
      root,
    );
    const reverse = parseFindingsV1(
      JSON.stringify({ schemaVersion: "1.0", findings: [second, first] }),
      root,
    );
    const ids = (document: typeof forward) =>
      Object.fromEntries(document.findings.map(({ title, id }) => [title, id]));

    expect(new Set(forward.findings.map(({ id }) => id)).size).toBe(2);
    expect(ids(forward)).toEqual(ids(reverse));
    expect(
      forward.findings.every(({ id }) => /^CF1-[a-f0-9]{64}$/.test(id)),
    ).toBe(true);
  });

  test("accepts one whole-output fenced json block", async () => {
    const root = await makeTempDir();
    const document = parseFindingsV1(
      `\`\`\`json\n${JSON.stringify({
        schemaVersion: "1.0",
        findings: [],
      })}\n\`\`\``,
      root,
    );

    expect(document).toEqual({ schemaVersion: "1.0", findings: [] });
  });

  test("rejects malformed finding documents", async () => {
    const outputs = [
      `Here you go: {"schemaVersion":"1.0","findings":[]}`,
      JSON.stringify({ schemaVersion: "1.0", findings: [], extra: true }),
      JSON.stringify({ schemaVersion: "1.0", findings: [{ title: "x" }] }),
      JSON.stringify({ schemaVersion: "2.0", findings: [] }),
    ];
    const root = await makeTempDir();
    for (const output of outputs) {
      expect(() => parseFindingsV1(output, root)).toThrow(
        expect.objectContaining({ code: "REVIEW_OUTPUT_INVALID" }),
      );
    }
  });

  test("rejects model ids and escaping finding paths", async () => {
    const root = await makeTempDir();
    const outputs = [
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [finding({ id: "model-id" } as never)],
      }),
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [finding({ file: "../secret.ts" })],
      }),
    ];

    for (const output of outputs) {
      expect(() => parseFindingsV1(output, root)).toThrow(
        expect.objectContaining({ code: "REVIEW_OUTPUT_INVALID" }),
      );
    }
  });

  test("rejects out-of-bounds finding confidence", async () => {
    const root = await makeTempDir();
    const output = JSON.stringify({
      schemaVersion: "1.0",
      findings: [finding({ confidence: 1.1 })],
    });

    expect(() => parseFindingsV1(output, root)).toThrow(
      expect.objectContaining({ code: "REVIEW_OUTPUT_INVALID" }),
    );
  });

  test("rejects duplicate derived ids and resource-limit violations", async () => {
    const root = await makeTempDir();
    const duplicate = {
      schemaVersion: "1.0",
      findings: [finding(), finding({ severity: "low", confidence: 0.1 })],
    };
    const tooMany = {
      schemaVersion: "1.0",
      findings: Array.from({ length: 201 }, (_, index) =>
        finding({ evidence: `evidence ${index}` }),
      ),
    };

    expect(() => parseFindingsV1(JSON.stringify(duplicate), root)).toThrow(
      expect.objectContaining({ code: "REVIEW_OUTPUT_INVALID" }),
    );
    expect(() => parseFindingsV1(JSON.stringify(tooMany), root)).toThrow(
      expect.objectContaining({ code: "REVIEW_OUTPUT_INVALID" }),
    );
    expect(() => parseFindingsV1(" ".repeat(1024 * 1024 + 1), root)).toThrow(
      expect.objectContaining({ code: "REVIEW_OUTPUT_INVALID" }),
    );
  });

  test("rejects unsafe controls in user-facing fields", async () => {
    const overrides = [
      ["title", { title: "bad\u0007title" }],
      ["evidence", { evidence: "bad\u001bevidence" }],
    ].map(([, override]) => override);
    const root = await makeTempDir();
    for (const override of overrides) {
      const output = JSON.stringify({
        schemaVersion: "1.0",
        findings: [finding(override)],
      });
      expect(() => parseFindingsV1(output, root)).toThrow(
        expect.objectContaining({ code: "REVIEW_OUTPUT_INVALID" }),
      );
    }
  });

  test("normalizes intended multiline newlines and permits tabs", async () => {
    const root = await makeTempDir();
    const document = parseFindingsV1(
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [
          finding({
            evidence: "first\r\n\tsecond",
            suggestedValidation: "one\rtwo",
          }),
        ],
      }),
      root,
    );

    expect(document.findings[0]?.evidence).toBe("first\n\tsecond");
    expect(document.findings[0]?.suggestedValidation).toBe("one\ntwo");
  });

  test("renders a safe human report from normalized findings", async () => {
    const root = await makeTempDir();
    const document = parseFindingsV1(
      JSON.stringify({
        schemaVersion: "1.0",
        findings: [
          finding({
            title: "# <script>alert(1)</script>",
            evidence: "```\n# injected",
            suggestedValidation: "<img src=x>",
          }),
        ],
      }),
      root,
    );
    const markdown = renderFindingsMarkdown(document);

    expect(markdown).toContain("# ChangeForge Findings");
    expect(markdown).toContain(document.findings[0]!.id);
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("<img");
    expect(markdown).not.toContain("\n# injected");
  });

  test("escapes ids and removes controls for direct renderer callers", () => {
    const markdown = renderFindingsMarkdown({
      schemaVersion: "1.0",
      findings: [
        {
          id: "CF1-safe\n# injected\u001b",
          title: "title\u0007",
          severity: "high",
          confidence: 1,
          file: "src/value.ts",
          line: 1,
          evidence: "evidence\u001b",
          suggestedValidation: "validation\u0085",
        },
      ],
    });

    expect(
      [...markdown].some((character) => {
        const code = character.codePointAt(0)!;
        return (
          code !== 9 &&
          code !== 10 &&
          code !== 13 &&
          (code <= 31 || (code >= 127 && code <= 159))
        );
      }),
    ).toBe(false);
    expect(markdown).not.toContain("\n# injected");
    expect(markdown).toContain("\\# injected");
  });
});

function finding(overrides: Record<string, unknown> = {}) {
  return {
    title: "Missing validation",
    severity: "high",
    confidence: 0.9,
    file: "src/value.ts",
    line: 12,
    evidence: "Missing guard.",
    suggestedValidation: "Add a boundary test.",
    ...overrides,
  };
}
