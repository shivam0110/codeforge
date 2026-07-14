import { describe, expect, test } from "vitest";
import {
  DIFFERENTIAL_SCHEMA_VERSION,
  buildDifferentialResult,
  classifyDifferential,
  parsePlaywrightJsonSide,
  type DifferentialSideV1,
} from "../../src/pipeline/differential.js";

const SPEC_FILE = "tests/value.spec.ts";

const playwrightTest = (
  status: string,
  extras: Record<string, unknown> = {},
) => ({
  expectedStatus: "passed",
  status: status === "passed" ? "expected" : "unexpected",
  results: [{ status, duration: 4, retry: 0, ...extras }],
});

const assertion = {
  message: "Error: expect(received).toBe(expected)",
  stack: `Error: expect(received).toBe(expected)\n    at ${SPEC_FILE}:4:20`,
  location: { file: SPEC_FILE, line: 4, column: 20 },
};

function report(
  tests: unknown[],
  errors: unknown[] = [],
  extras: Record<string, unknown> = {},
  file = SPEC_FILE,
) {
  return {
    suites: [
      {
        title: "root",
        suites: [{ title: "nested", specs: [{ title: "spec", file, tests }] }],
      },
    ],
    errors,
    ...extras,
  };
}

const command = (overrides: Record<string, unknown> = {}) => ({
  command: "npx playwright test --reporter=json",
  exitCode: 0,
  durationMs: 12,
  timedOut: false,
  signal: null,
  errorCode: null,
  stdout: JSON.stringify(report([playwrightTest("passed")])),
  stderr: "",
  ...overrides,
});

function parse(
  overrides: Record<string, unknown> = {},
  side: "base" | "head" = "head",
  expected?: { root: string; path: string },
) {
  return parsePlaywrightJsonSide(
    side,
    command(overrides),
    `logs/${side}.json`,
    expected,
  );
}

function side(
  kind: "base" | "head",
  outcome: DifferentialSideV1["outcome"],
): DifferentialSideV1 {
  return {
    side: kind,
    outcome,
    command: "playwright test",
    exitCode: outcome === "passed" ? 0 : 1,
    durationMs: 1,
    timedOut: false,
    signal: null,
    errorCode: null,
    counts: {
      total: 1,
      passed: outcome === "passed" ? 1 : 0,
      failed: outcome === "failed" ? 1 : 0,
      skipped: 0,
    },
    errors: [],
    stdout: "{}",
    stderr: "",
    logPath: `/tmp/${kind}.log`,
  };
}

describe("Playwright JSON differential parsing", () => {
  test("recursively parses a nested passing report", () => {
    const result = parse({
      stdout: JSON.stringify(
        report([playwrightTest("passed"), playwrightTest("passed")]),
      ),
    });

    expect(result).toMatchObject({
      side: "head",
      outcome: "passed",
      command: "npx playwright test --reporter=json",
      exitCode: 0,
      durationMs: 12,
      counts: { total: 2, passed: 2, failed: 0, skipped: 0 },
      logPath: "logs/head.json",
    });
  });

  test("accepts failures attributable to the generated spec", () => {
    const values = [
      report([
        playwrightTest("failed", {
          error: {
            message: "Error: boom",
            location: { file: SPEC_FILE, line: 8, column: 3 },
          },
        }),
      ]),
      report([
        playwrightTest("failed", {
          error: {
            message: "Error: boom",
            stack: "Error: boom\n    at tests/./nested/../value.spec.ts:10:5",
          },
        }),
      ]),
      report(
        [
          playwrightTest("failed", {
            error: {
              message: "Error: boom",
              location: {
                file: "/tmp/tests/value.spec.ts",
                line: 2,
                column: 1,
              },
            },
          }),
        ],
        [],
        {},
        "file:///tmp/tests/value.spec.ts",
      ),
    ];

    for (const value of values) {
      expect(
        parse({ exitCode: 1, stdout: JSON.stringify(value) }, "base").outcome,
      ).toBe("failed");
    }
  });

  test("rejects foreign and infrastructure attribution", () => {
    const values = [
      report([
        playwrightTest("failed", {
          error: {
            message: "Error: boom",
            location: { file: `../${SPEC_FILE}`, line: 2, column: 1 },
          },
        }),
      ]),
      report([
        playwrightTest("failed", {
          errors: [
            assertion,
            {
              message: "Fixture failed",
              location: { file: "tests/fixtures.ts", line: 3, column: 1 },
            },
          ],
        }),
      ]),
      report([
        playwrightTest("failed", {
          error: {
            message: "browserType.launch: Executable doesn't exist",
            location: { file: SPEC_FILE, line: 3, column: 1 },
          },
        }),
      ]),
      report([
        playwrightTest("failed", {
          error: {
            message: "Error: database connection refused",
            stack: "at global.setup.ts:3:1",
          },
        }),
      ]),
    ];

    for (const value of values) {
      expect(
        parse({ exitCode: 1, stdout: JSON.stringify(value) }, "base").outcome,
      ).toBe("invalid");
    }

    const unrelated = report(
      [playwrightTest("failed", { error: assertion })],
      [],
      {},
      "tests/unrelated.spec.ts",
    );
    const bound = parse(
      { exitCode: 1, stdout: JSON.stringify(unrelated) },
      "base",
      { root: "/repo", path: SPEC_FILE },
    );
    expect(bound.outcome).toBe("invalid");
    expect(bound.errors.join("\n")).toMatch(/unexpected spec/i);
  });

  test("preserves failure aggregation integrity", () => {
    const result = parse(
      {
        exitCode: 1,
        stdout: JSON.stringify(
          report([
            playwrightTest("failed", {
              error: {
                message: "Fixture failed",
                location: { file: "fixtures.ts", line: 1, column: 1 },
              },
              errors: [
                assertion,
                { ...assertion },
                {
                  message: "Error: boom",
                  stack: "Error: boom\n    at tests/fixtures.ts:3:1",
                },
                {
                  message: "Error: boom",
                  stack: `Error: boom\n    at ${SPEC_FILE}:4:1`,
                },
              ],
            }),
          ]),
        ),
      },
      "base",
    );

    expect(result.outcome).toBe("invalid");
    expect(result.errors.join("\n")).toContain("Fixture failed");
    expect(
      result.errors.filter((error) => error.includes("Error: boom")),
    ).toHaveLength(2);

    const passingWithError = parse({
      stdout: JSON.stringify(
        report([playwrightTest("passed", { error: assertion })]),
      ),
    });
    expect(passingWithError.outcome).toBe("invalid");
  });

  test("rejects retry, flaky, and skipped evidence", () => {
    const retry = {
      expectedStatus: "passed",
      status: "flaky",
      results: [
        { status: "failed", retry: 0, error: assertion },
        { status: "passed", retry: 1 },
      ],
    };
    const retriedPass = {
      expectedStatus: "passed",
      status: "expected",
      results: [{ status: "passed", retry: 1 }],
    };
    const skipped = {
      ...playwrightTest("skipped"),
      expectedStatus: "skipped",
      status: "skipped",
    };

    for (const value of [retry, retriedPass, skipped]) {
      expect(parse({ stdout: JSON.stringify(report([value])) }).outcome).toBe(
        "invalid",
      );
    }
    expect(
      parse({
        stdout: JSON.stringify(
          report([playwrightTest("passed")], [], { stats: { flaky: 1 } }),
        ),
      }).outcome,
    ).toBe("invalid");
  });

  test("rejects process and result integrity mismatches", () => {
    for (const overrides of [
      { timedOut: true },
      { exitCodeKnown: false },
      { exitCode: 2 },
    ]) {
      expect(parse(overrides).outcome).toBe("invalid");
    }

    const unsupported = parse({
      exitCode: 1,
      stdout: JSON.stringify(report([playwrightTest("timedOut")])),
    });
    const failedWithZero = parse(
      {
        stdout: JSON.stringify(
          report([playwrightTest("failed", { error: assertion })]),
        ),
      },
      "base",
    );
    expect(unsupported.outcome).toBe("invalid");
    expect(failedWithZero.outcome).toBe("invalid");
  });

  test("rejects malformed, setup, and empty reports", () => {
    const values = [
      "not-json",
      JSON.stringify({ suites: "wrong" }),
      JSON.stringify(report([], [{ message: "Error in global setup" }])),
      JSON.stringify(report([])),
    ];

    for (const stdout of values) {
      const result = parse({ exitCode: 1, stdout });
      expect(result.outcome).toBe("invalid");
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("bounds stored output and errors", () => {
    const stdout = "x".repeat(2_000_000);
    const oversized = parse({ stdout });
    expect(oversized.outcome).toBe("invalid");
    expect(oversized.stdout.length).toBeLessThan(stdout.length);
    expect(oversized.errors.join("\n")).toContain("exceeds 1048576 bytes");

    const message = `Error: ${"detail ".repeat(1_000)}`;
    const attributable = parse(
      {
        exitCode: 1,
        stdout: JSON.stringify(
          report([
            playwrightTest("failed", {
              error: {
                message,
                location: { file: SPEC_FILE, line: 5, column: 2 },
              },
            }),
          ]),
        ),
      },
      "base",
    );
    expect(attributable.outcome).toBe("failed");
    expect(attributable.errors[0]).toHaveLength(4_096);

    const huge = "failure ".repeat(20_000);
    const bounded = parse(
      {
        exitCode: 1,
        stderr: huge,
        stdout: JSON.stringify(report([], [{ message: huge }])),
      },
      "base",
    );
    expect(bounded.stderr.length).toBeLessThan(huge.length);
    expect(bounded.errors.every((error) => error.length <= 4_096)).toBe(true);

    const many = Array.from({ length: 51 }, () =>
      playwrightTest("failed", { error: assertion }),
    );
    const overflow = parse(
      { exitCode: 1, stdout: JSON.stringify(report(many)) },
      "base",
    );
    expect(overflow.outcome).toBe("invalid");
    expect(overflow.errors).toHaveLength(50);

    const minimal = {
      expectedStatus: "passed",
      status: "expected",
      results: [{ status: "passed" }],
    };
    const tooMany = parse({
      stdout: JSON.stringify(
        report(Array.from({ length: 10_001 }, () => minimal)),
      ),
    });
    expect(tooMany.outcome).toBe("invalid");
    expect(tooMany.errors.join("\n")).toContain("exceeds 10000 tests");

    let nested: Record<string, unknown> = {
      specs: [{ file: SPEC_FILE, tests: [minimal] }],
    };
    for (let depth = 0; depth < 66; depth += 1) nested = { suites: [nested] };
    const tooDeep = parse({
      stdout: JSON.stringify({ suites: [nested], errors: [] }),
    });
    expect(tooDeep.outcome).toBe("invalid");
    expect(tooDeep.errors.join("\n")).toContain(
      "nesting exceeds the supported depth",
    );
  });
});

describe("differential classification", () => {
  test("classifies each distinct outcome branch", () => {
    const cases = [
      ["failed", "passed", "regression-proof"],
      ["passed", "passed", "no-discrimination"],
      ["passed", "failed", "regression-detected"],
      ["failed", "failed", "invalid"],
      ["invalid", "passed", "invalid"],
    ] as const;

    for (const [base, head, expected] of cases) {
      expect(classifyDifferential(side("base", base), side("head", head))).toBe(
        expected,
      );
    }
  });

  test("builds a deterministic versioned document", () => {
    const first = buildDifferentialResult(
      side("base", "failed"),
      side("head", "passed"),
    );
    const second = buildDifferentialResult(
      side("base", "failed"),
      side("head", "passed"),
    );

    expect(first).toMatchObject({
      schemaVersion: DIFFERENTIAL_SCHEMA_VERSION,
      classification: "regression-proof",
      base: { side: "base" },
      head: { side: "head" },
    });
    expect(first.reason).toContain("fails on base");
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
