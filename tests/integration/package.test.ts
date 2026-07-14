import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { beforeAll, describe, expect, test } from "vitest";
import { installedManifest, installPackedFixture } from "../utils/package.js";

describe("published package", () => {
  let consumer: string;

  beforeAll(async () => {
    consumer = await installPackedFixture();
  }, 120_000);

  test("supports library, CLI, and package-content contracts from a packed consumer", async () => {
    const result = await execa(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "process.argv = [process.execPath, 'consumer', '--invalid']; const { runPipeline } = await import('changeforge'); console.log(typeof runPipeline)",
      ],
      { cwd: consumer },
    );
    expect(result.stdout).toBe("function");

    const bin = join(
      consumer,
      "node_modules/.bin",
      process.platform === "win32" ? "changeforge.cmd" : "changeforge",
    );
    const cli = await execa(bin, ["run", "--help"], { cwd: consumer });
    expect(cli.stdout).toContain("Usage: changeforge run");
    expect(cli.stdout).toContain("--generate");
    expect(cli.stdout).toContain("--execute");
    expect(cli.stdout).not.toContain("--in-place");

    const packageDir = join(consumer, "node_modules/changeforge");
    const manifest = await installedManifest(consumer);
    expect(manifest).toMatchObject({
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      bin: { changeforge: "dist/bin.js" },
    });
    await expect(
      access(join(packageDir, "dist/index.js")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(packageDir, "dist/index.d.ts")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(packageDir, "dist/bin.js")),
    ).resolves.toBeUndefined();
    await expect(
      access(
        join(
          consumer,
          "node_modules/.bin",
          process.platform === "win32" ? "changeforge.cmd" : "changeforge",
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(packageDir, "dist/index.d.ts"), "utf8"),
    ).resolves.toMatch(/RunOptions.*RunSummary/s);
    await expect(
      readFile(join(packageDir, "dist/pipeline/summarize.d.ts"), "utf8"),
    ).resolves.toContain('"passed" | "partial" | "failed"');
    await expect(access(join(packageDir, "src"))).rejects.toThrow();
    await expect(access(join(packageDir, "tests"))).rejects.toThrow();
  });
});
