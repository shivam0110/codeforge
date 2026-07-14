import { describe, expect, test } from "vitest";
import { inspectGeneratedSpec } from "../../src/pipeline/spec-policy.js";

type Options = Parameters<typeof inspectGeneratedSpec>[1];

const FALLBACK = {
  fallback: true,
  webServerUrl: "http://127.0.0.1:3000",
} satisfies Options;
const CONFIGURED = {
  fallback: false,
  targetFile: "/repo/tests/x.spec.ts",
  workRoot: "/repo",
  webServerUrl: "http://127.0.0.1:3000",
} satisfies Options;

const rules = (source: string, options: Options = FALLBACK) =>
  inspectGeneratedSpec(source, options).map(({ rule }) => rule);

const spec = (body: string) => `
  import { test, expect } from "@playwright/test";
  test("x", async ({ page }) => {
    ${body}
  });
`;

describe("generated spec policy", () => {
  test("accepts positive fallback Playwright grammar", () => {
    const source = `
      import { test as base, expect as verify } from "@playwright/test";
      const test = base.extend({});
      test("dashboard", async ({ page }) => {
        await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
        await verify.soft(page.getByRole("heading", { name: "Dashboard" }).first()).toBeVisible();
      });
    `;

    expect(rules(source)).toEqual([]);
  });

  test("rejects malformed or non-Playwright registration", () => {
    expect(rules("import {")).toContain("invalid-syntax");
    expect(
      rules(`
        const test = (_name: string, body: () => void) => body();
        const expect = (value: unknown) => ({ toBeDefined() {} });
        test("fake", () => expect(Date.now()).toBeDefined());
      `),
    ).toEqual(
      expect.arrayContaining(["missing-playwright-import", "no-tests"]),
    );
    expect(
      rules('import { test } from "@playwright/test"; test("missing body");'),
    ).toContain("no-tests");
  });

  test("rejects modifiers and meaningless assertions", () => {
    const skipped = rules(`
      import { test, expect } from "@playwright/test";
      test.skip("later", () => expect(true as boolean).toBe(true));
    `);
    const focused = rules(
      spec(
        'test.fail(); await page.goto("/"); await expect(page.locator("main")).toBeVisible();',
      ).replace('test("x"', 'test.only("x"'),
    );
    const fakeMatcher = rules(
      spec('await page.goto("/"); expect(page.url()).toString();'),
    );

    expect(skipped).toEqual(
      expect.arrayContaining([
        "skipped-test",
        "placeholder-assertion",
        "no-meaningful-assertion",
      ]),
    );
    expect(focused).toContain("test-modifier");
    expect(fakeMatcher).toContain("no-meaningful-assertion");
  });

  test("rejects configured-target runtime capabilities", () => {
    const bodies = [
      "expect(process.env.SECRET).toBeUndefined();",
      'await import("./helper.js"); await expect(page).toBeDefined();',
      'await fetch("https://evil.example"); await expect(page).toBeDefined();',
      'new WebSocket("wss://evil.example"); await expect(page).toBeDefined();',
      '(() => {})["constructor"]("return process")(); await expect(page).toBeDefined();',
    ];

    for (const body of bodies)
      expect(rules(spec(body), CONFIGURED)).toContain("unsafe-runtime");
  });

  test("rejects forbidden and workspace-escaping imports", () => {
    const cases: Array<[string, string]> = [
      ['import fs from "node:fs";', "forbidden-import"],
      ['import axios from "axios";', "forbidden-import"],
      ['import helper from "../../outside.js";', "import-outside-workspace"],
    ];

    for (const [extraImport, expected] of cases) {
      const source = `${extraImport}\n${spec('await page.goto("/"); await expect(page).toBeDefined();')}`;
      expect(rules(source, CONFIGURED)).toContain(expected);
    }
  });

  test("rejects Playwright request access", () => {
    const imported = `
      import { test, expect, request } from "@playwright/test";
      test("x", async ({ page }) => { await page.goto("/"); await expect(request).toBeDefined(); });
    `;
    const fixture = `
      import { test, expect } from "@playwright/test";
      test("x", async ({ page, request }) => { await page.goto("/"); await expect(request).toBeDefined(); });
    `;

    expect(rules(imported, CONFIGURED)).toContain("unsafe-runtime");
    expect(rules(fixture, CONFIGURED)).toContain("unsafe-runtime");
  });

  test("rejects computed module loaders", () => {
    for (const body of [
      'process["getBuiltinModule"]("node:fs"); await expect(page).toBeDefined();',
      'module["_load"]("node:fs"); await expect(page).toBeDefined();',
    ]) {
      expect(rules(spec(body), CONFIGURED)).toContain("unsafe-runtime");
    }
  });

  test("allows safe declarations and ordinary properties", () => {
    const source = `
      import { test, expect } from "@playwright/test";
      type process = { env: string };
      interface WebSocket { readyState: number }
      function fetch(input: string) { return input; }
      const labels = { require: "text", constructor: "label", globalThis: "note" };
      test("x", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(page.locator("main")).toBeVisible();
      });
    `;

    expect(rules(source, CONFIGURED)).toEqual([]);
  });

  test("rejects top-level execution", () => {
    const direct = `${spec('await page.goto("/"); await expect(page.locator("main")).toBeVisible();')}\nstartServer();`;
    const imported = `
      import "./setup.js";
      export default startServer();
      ${spec('await page.goto("/"); await expect(page.locator("main")).toBeVisible();')}
    `;

    expect(rules(direct, CONFIGURED)).toContain("top-level-side-effect");
    expect(rules(imported, CONFIGURED)).toContain("top-level-side-effect");
  });

  test("enforces configured-target navigation", () => {
    expect(
      rules(
        spec(
          'await page.goto("http://127.0.0.1:3000/dashboard"); await expect(page).toBeDefined();',
        ),
        CONFIGURED,
      ),
    ).toEqual([]);

    for (const target of [
      '"https://evil.example"',
      '"//evil.example"',
      "target",
    ]) {
      const declaration =
        target === "target" ? 'const target = "https://evil.example";' : "";
      expect(
        rules(
          spec(
            `${declaration} await page.goto(${target}); await expect(page).toBeDefined();`,
          ),
          CONFIGURED,
        ),
      ).toContain("navigation-target");
    }
  });

  test("rejects shadowed Playwright bindings", () => {
    const page = rules(
      spec(
        'const page = { goto: async (_url: string) => {} }; await page.goto("/"); expect(Date.now()).toBeGreaterThan(0);',
      ),
    );
    const assertion = rules(
      spec(
        'const expect = (_value: unknown) => ({ toBeVisible() {} }); await page.goto("/"); expect(page).toBeVisible();',
      ),
    );

    expect(page).toEqual(
      expect.arrayContaining(["shadowed-binding", "no-meaningful-assertion"]),
    );
    expect(assertion).toContain("shadowed-binding");
  });

  test("enforces awaited and static fallback grammar", () => {
    const sources = [
      spec('page.goto("/"); expect(page.locator("main")).toBeVisible();'),
      spec(
        'page.goto = async () => null; await page.goto("/"); await expect(page).toBeDefined();',
      ),
      spec(
        'await page.goto("/", arbitraryExpression()); await expect(page).toBeDefined();',
      ),
      spec('await page.goto("/"); await expect(page).toBeDefined();').replace(
        'test("x", async',
        'test("x", fetch("https://evil.example"), async',
      ),
    ];

    for (const source of sources)
      expect(rules(source)).toContain("fallback-grammar");
  });

  test("ignores navigation in unused helpers", () => {
    const source = `
      import { test, expect } from "@playwright/test";
      async function unused(page: { goto(url: string): Promise<void> }) { await page.goto("/"); }
      test("x", async ({ page }) => { await expect(page.locator("main")).toBeVisible(); });
    `;

    expect(rules(source)).toContain("no-app-navigation");
  });
});
