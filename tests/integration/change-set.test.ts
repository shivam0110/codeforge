import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  materializeChangeSet,
  materializeRevision,
  resolveChangeSet,
  restoreChangeSet,
  snapshotChangeSet,
  validateChangeSnapshotV1,
} from "../../src/git/change-set.js";
import { repoRoot } from "../../src/git/repo.js";
import { makeTempDir } from "../utils/fs.js";
import { commitFiles, committedRepo, git } from "../utils/git.js";

describe("resolved Git change sets", () => {
  const symlinkTest = test;

  async function snapshotFixture() {
    const repo = await committedRepo({ "value.txt": "old\n" });
    await writeFile(path.join(repo, "value.txt"), "new\n");
    return {
      repo,
      valid: snapshotChangeSet(
        await resolveChangeSet(repo, { kind: "working-tree" }),
      ),
    };
  }

  test("captures dirty bytes before materialization", async () => {
    const repo = await committedRepo({ "src.js": "export const value = 1;\n" });
    await writeFile(path.join(repo, "src.js"), "export const value = 2;\n");

    const change = await resolveChangeSet(repo, { kind: "working-tree" });
    await writeFile(path.join(repo, "src.js"), "export const value = 3;\n");
    const work = path.join(await makeTempDir(), "sandbox");
    await materializeChangeSet(change, work);

    await expect(readFile(path.join(work, "src.js"), "utf8")).resolves.toBe(
      "export const value = 2;\n",
    );
  });

  test("reports a missing explicit file relative to the repository root", async () => {
    const repo = await committedRepo({ "services/app/value.ts": "export {};\n" });

    await expect(
      resolveChangeSet(repo, { kind: "file", value: "pages/api/value.ts" }),
    ).rejects.toMatchObject({
      code: "GIT_FILE_NOT_FOUND",
      message: expect.stringContaining("pages/api/value.ts"),
    });
  });

  symlinkTest(
    "restores captured binary, symlink, and deletion state after checkout drift",
    async () => {
      const repo = await committedRepo({
        "asset.bin": Buffer.from([0, 1, 2]),
        "deleted.txt": "delete me\n",
        "target.txt": "target\n",
      });
      await symlink("target.txt", path.join(repo, "link"));
      await git(repo, ["add", "link"]);
      await git(repo, ["commit", "-m", "add link"]);
      const expected = Buffer.from([0, 255, 4]);
      await writeFile(path.join(repo, "asset.bin"), expected);
      await rm(path.join(repo, "deleted.txt"));
      await rm(path.join(repo, "link"));
      await symlink("other-target", path.join(repo, "link"));
      const snapshot = snapshotChangeSet(
        await resolveChangeSet(repo, { kind: "working-tree" }),
      );

      await git(repo, ["checkout", "--", "."]);
      await writeFile(path.join(repo, "asset.bin"), Buffer.from([9, 9, 9]));
      const restored = await restoreChangeSet(
        repo,
        JSON.parse(JSON.stringify(snapshot)),
      );
      const work = path.join(await makeTempDir(), "sandbox");
      await materializeChangeSet(restored, work);

      await expect(readFile(path.join(work, "asset.bin"))).resolves.toEqual(
        expected,
      );
      await expect(readlink(path.join(work, "link"))).resolves.toBe(
        "other-target",
      );
      await expect(lstat(path.join(work, "deleted.txt"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    },
  );

  test("materializes immutable revisions, including an empty base tree", async () => {
    const repo = await committedRepo({ "one.txt": "one\n" });
    const first = (await git(repo, ["rev-parse", "HEAD"])).toString().trim();
    const second = await commitFiles(repo, {
      "one.txt": "two\n",
      "two.txt": "two\n",
    });
    const oldWork = path.join(await makeTempDir(), "old");
    await materializeRevision(repo, first, true, oldWork);

    await expect(readFile(path.join(oldWork, "one.txt"), "utf8")).resolves.toBe(
      "one\n",
    );
    await expect(lstat(path.join(oldWork, "two.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const change = await resolveChangeSet(repo, {
      kind: "commit",
      value: first,
    });
    const emptyWork = path.join(await makeTempDir(), "empty");
    await materializeRevision(repo, change.baseSha, true, emptyWork);
    expect((await lstat(emptyWork)).isDirectory()).toBe(true);
    expect(await readdir(emptyWork)).toEqual([]);
    expect(second).not.toBe(first);
  });

  test("rejects snapshot schema, unknown keys, and invalid object ids", async () => {
    const { valid } = await snapshotFixture();
    for (const value of [
      { ...valid, schemaVersion: "2.0" },
      { ...valid, extra: true },
      { ...valid, headSha: "a".repeat(64) },
    ]) {
      expect(() => validateChangeSnapshotV1(value)).toThrow(
        expect.objectContaining({ code: "CHANGE_SNAPSHOT_INVALID" }),
      );
    }
  });

  test("rejects unsafe snapshot paths", async () => {
    const { valid } = await snapshotFixture();
    for (const value of [
      { ...valid, overlay: [{ ...valid.overlay[0], path: "../escape" }] },
      {
        ...valid,
        overlay: [{ ...valid.overlay[0], path: ".changeforge-runtime/escape" }],
      },
      { ...valid, overlay: [{ ...valid.overlay[0], path: "bad:name" }] },
    ]) {
      expect(() => validateChangeSnapshotV1(value)).toThrow(
        expect.objectContaining({ code: "CHANGE_SNAPSHOT_INVALID" }),
      );
    }
  });

  test("rejects invalid overlay metadata and content", async () => {
    const { valid } = await snapshotFixture();
    for (const value of [
      { ...valid, overlay: [{ ...valid.overlay[0], extra: true }] },
      {
        ...valid,
        overlay: [
          {
            ...valid.overlay[0],
            entry: { ...valid.overlay[0].entry, mode: 0o100600 },
          },
        ],
      },
      {
        ...valid,
        overlay: [
          {
            ...valid.overlay[0],
            entry: { ...valid.overlay[0].entry, data: "YQ" },
          },
        ],
      },
      {
        ...valid,
        overlay: [
          {
            ...valid.overlay[0],
            entry: { ...valid.overlay[0].entry, sha256: "0".repeat(64) },
          },
        ],
      },
    ]) {
      expect(() => validateChangeSnapshotV1(value)).toThrow(
        expect.objectContaining({ code: "CHANGE_SNAPSHOT_INVALID" }),
      );
    }
  });

  test("fails closed when snapshot source objects are unavailable", async () => {
    const { valid } = await snapshotFixture();

    const other = await committedRepo({ "other.txt": "other\n" });
    await expect(restoreChangeSet(other, valid)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    await expect(
      materializeRevision(
        other,
        valid.headSha,
        true,
        path.join(await makeTempDir(), "missing"),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  test("validates snapshot inputs and permits reviewed ChangeForge config", async () => {
    const repo = await committedRepo({
      ".changeforge/config.json": "{}\n",
      "value.txt": "old\n",
    });
    await writeFile(
      path.join(repo, ".changeforge/config.json"),
      '{"changed":true}\n',
    );
    const fileSnapshot = snapshotChangeSet(
      await resolveChangeSet(repo, {
        kind: "file",
        value: ".changeforge/config.json",
      }),
    );
    expect(fileSnapshot.input).toEqual({
      kind: "file",
      value: ".changeforge/config.json",
    });
    await mkdir(path.join(repo, ".changeforge/runs"));
    await writeFile(path.join(repo, ".changeforge/runs/run.json"), "{}\n");
    await expect(
      resolveChangeSet(repo, {
        kind: "file",
        value: ".changeforge/runs/run.json",
      }),
    ).rejects.toMatchObject({ code: "GIT_PATH_INVALID" });

    for (const value of [
      "../escape",
      "/escape",
      "C:\\escape",
      ".changeforge/runs/run-1",
      ".ChangeForge/RUNS/run-1",
      ".changeforge-runtime/file",
      "bad\0path",
    ]) {
      const input = { kind: "file", value } as const;
      expect(() =>
        validateChangeSnapshotV1({
          ...fileSnapshot,
          input,
          diff: { ...fileSnapshot.diff, input },
        }),
      ).toThrow(expect.objectContaining({ code: "CHANGE_SNAPSHOT_INVALID" }));
    }

    const committed = { ...fileSnapshot, overlay: [] };
    for (const input of [
      { kind: "commit", value: "" },
      { kind: "commit", value: "bad\0ref" },
      { kind: "range", value: `bad${String.fromCharCode(0x85)}ref` },
    ] as const) {
      expect(() =>
        validateChangeSnapshotV1({
          ...committed,
          input,
          diff: { ...committed.diff, input },
        }),
      ).toThrow(expect.objectContaining({ code: "CHANGE_SNAPSHOT_INVALID" }));
    }
    const range = {
      kind: "range",
      value: "refs/heads/feature...HEAD",
    } as const;
    expect(
      validateChangeSnapshotV1({
        ...committed,
        input: range,
        diff: { ...committed.diff, input: range },
      }).input,
    ).toEqual(range);
  });

  test("refuses nonempty materialization destinations before writing", async () => {
    const repo = await committedRepo({ "value.txt": "old\n" });
    await writeFile(path.join(repo, "value.txt"), "new\n");
    const change = await resolveChangeSet(repo, { kind: "working-tree" });
    const work = path.join(await makeTempDir(), "sandbox");
    await mkdir(work);
    await writeFile(path.join(work, "keep.txt"), "keep\n");

    await expect(materializeChangeSet(change, work)).rejects.toMatchObject({
      code: "PATH_NOT_EMPTY",
    });
    await expect(
      materializeRevision(repo, change.headSha, true, work),
    ).rejects.toMatchObject({ code: "PATH_NOT_EMPTY" });
    await expect(readFile(path.join(work, "keep.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
    await expect(lstat(path.join(work, "value.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("handles clean and changed core.autocrlf checkouts", async () => {
    const repo = await committedRepo({ "value.txt": "one\ntwo\n" });
    await git(repo, ["config", "core.autocrlf", "true"]);
    await rm(path.join(repo, "value.txt"));
    await git(repo, ["checkout", "--", "value.txt"]);

    await expect(readFile(path.join(repo, "value.txt"), "utf8")).resolves.toBe(
      "one\r\ntwo\r\n",
    );
    await expect(
      resolveChangeSet(repo, { kind: "working-tree" }),
    ).rejects.toMatchObject({ code: "GIT_EMPTY_CHANGE" });
    await expect(
      resolveChangeSet(repo, { kind: "file", value: "value.txt" }),
    ).rejects.toMatchObject({ code: "GIT_EMPTY_CHANGE" });
    await expect(git(repo, ["status", "--porcelain"])).resolves.toEqual(
      Buffer.alloc(0),
    );

    const changedRepo = await committedRepo({
      "value.txt": "one\ntwo\nthree\n",
    });
    await git(changedRepo, ["config", "core.autocrlf", "true"]);
    await rm(path.join(changedRepo, "value.txt"));
    await git(changedRepo, ["checkout", "--", "value.txt"]);
    await writeFile(
      path.join(changedRepo, "value.txt"),
      "one\r\nTWO\r\nthree\r\n",
    );

    const change = await resolveChangeSet(changedRepo, {
      kind: "working-tree",
    });
    const work = path.join(await makeTempDir(), "sandbox");
    await materializeChangeSet(change, work);

    expect(change.diff.patch).toContain("-two\n+TWO");
    expect(change.diff.patch).not.toContain("\r");
    expect(change.diff.patch).not.toContain("-one");
    await expect(readFile(path.join(work, "value.txt"), "utf8")).resolves.toBe(
      "one\r\nTWO\r\nthree\r\n",
    );
  });

  symlinkTest("handles core.symlinks=false checkouts", async () => {
    const repo = await committedRepo({ "target.txt": "target\n" });
    await symlink("target.txt", path.join(repo, "link"));
    await git(repo, ["add", "link"]);
    await git(repo, ["commit", "-m", "add link"]);
    await git(repo, ["config", "core.symlinks", "false"]);
    await rm(path.join(repo, "link"));
    await git(repo, ["checkout", "--", "link"]);

    expect((await lstat(path.join(repo, "link"))).isFile()).toBe(true);
    await expect(
      resolveChangeSet(repo, { kind: "working-tree" }),
    ).rejects.toMatchObject({ code: "GIT_EMPTY_CHANGE" });
    await expect(git(repo, ["status", "--porcelain"])).resolves.toEqual(
      Buffer.alloc(0),
    );

    const head = (await git(repo, ["rev-parse", "HEAD"])).toString().trim();
    const change = await resolveChangeSet(repo, {
      kind: "commit",
      value: head,
    });
    const work = path.join(await makeTempDir(), "sandbox");

    await materializeChangeSet(change, work);

    expect((await lstat(path.join(work, "link"))).isFile()).toBe(true);
    await expect(readFile(path.join(work, "link"), "utf8")).resolves.toBe(
      "target.txt",
    );
  });

  test("ignores inherited Git repository routing variables", async () => {
    const first = await committedRepo({ "first.txt": "first\n" });
    const second = await committedRepo({ "second.txt": "second\n" });
    const head = (await git(first, ["rev-parse", "HEAD"])).toString().trim();
    const previous = {
      dir: process.env.GIT_DIR,
      workTree: process.env.GIT_WORK_TREE,
    };
    process.env.GIT_DIR = path.join(second, ".git");
    process.env.GIT_WORK_TREE = second;
    try {
      await expect(repoRoot(first)).resolves.toBe(await realpath(first));
      const change = await resolveChangeSet(first, {
        kind: "commit",
        value: head,
      });
      expect(change.tree.has("first.txt")).toBe(true);
      expect(change.tree.has("second.txt")).toBe(false);
    } finally {
      if (previous.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous.dir;
      if (previous.workTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previous.workTree;
    }
  });

  test("does not treat sparse-checkout exclusions as deletions", async () => {
    const repo = await committedRepo({
      "keep/a.txt": "old\n",
      "drop/b.txt": "untouched\n",
    });
    await git(repo, ["sparse-checkout", "init", "--cone"]);
    await git(repo, ["sparse-checkout", "set", "keep"]);
    await writeFile(path.join(repo, "keep/a.txt"), "new\n");

    const change = await resolveChangeSet(repo, { kind: "working-tree" });

    expect(change.diff.changedFiles).toEqual([
      { status: "M", paths: ["keep/a.txt"] },
    ]);
  });

  test("preserves staged bytes for a missing sparse-checkout path", async () => {
    const repo = await committedRepo({
      "keep/a.txt": "keep\n",
      "drop/b.txt": "old\n",
    });
    await git(repo, ["sparse-checkout", "init", "--cone"]);
    await git(repo, ["sparse-checkout", "set", "keep"]);
    const oid = (await git(repo, ["hash-object", "-w", "--stdin"], "staged\n"))
      .toString()
      .trim();
    await git(repo, [
      "update-index",
      "--cacheinfo",
      `100644,${oid},drop/b.txt`,
    ]);

    const change = await resolveChangeSet(repo, { kind: "working-tree" });
    const work = path.join(await makeTempDir(), "sandbox");
    await materializeChangeSet(change, work);

    expect(change.diff.changedFiles).toEqual([
      { status: "M", paths: ["drop/b.txt"] },
    ]);
    await expect(readFile(path.join(work, "drop/b.txt"), "utf8")).resolves.toBe(
      "staged\n",
    );
  });

  test("prefers physical bytes when an excluded sparse path is recreated", async () => {
    const repo = await committedRepo({
      "keep/a.txt": "keep\n",
      "drop/b.txt": "old\n",
    });
    await git(repo, ["sparse-checkout", "init", "--cone"]);
    await git(repo, ["sparse-checkout", "set", "keep"]);
    await mkdir(path.join(repo, "drop"));
    await writeFile(path.join(repo, "drop/b.txt"), "physical\n");

    const change = await resolveChangeSet(repo, { kind: "working-tree" });
    const work = path.join(await makeTempDir(), "sandbox");
    await materializeChangeSet(change, work);

    await expect(readFile(path.join(work, "drop/b.txt"), "utf8")).resolves.toBe(
      "physical\n",
    );
  });

  test("limits file input to one captured path", async () => {
    const repo = await committedRepo({
      "a.txt": "old a\n",
      "b.txt": "old b\n",
    });
    await writeFile(path.join(repo, "a.txt"), "new a\n");
    await writeFile(path.join(repo, "b.txt"), "new b\n");

    const change = await resolveChangeSet(repo, {
      kind: "file",
      value: "a.txt",
    });
    const work = path.join(await makeTempDir(), "sandbox");
    await materializeChangeSet(change, work);

    expect(change.diff.changedFiles).toEqual([
      { status: "M", paths: ["a.txt"] },
    ]);
    await expect(readFile(path.join(work, "a.txt"), "utf8")).resolves.toBe(
      "new a\n",
    );
    await expect(readFile(path.join(work, "b.txt"), "utf8")).resolves.toBe(
      "old b\n",
    );
  });

  test("fails closed when a shallow commit is missing its declared parent", async () => {
    const source = await committedRepo({ "value.txt": "base\n" });
    await commitFiles(source, { "value.txt": "head\n" });
    const clone = path.join(await makeTempDir(), "clone");
    await git(source, [
      "clone",
      "--depth=1",
      pathToFileURL(source).href,
      clone,
    ]);
    const head = (await git(clone, ["rev-parse", "HEAD"])).toString().trim();

    await expect(
      resolveChangeSet(clone, { kind: "commit", value: head }),
    ).rejects.toMatchObject({
      code: "GIT_HISTORY_SHALLOW",
      suggestion: expect.stringContaining("git fetch --unshallow"),
    });
  });

  test("resolves two-dot and three-dot ranges to immutable commits", async () => {
    const repo = await committedRepo({ "value.txt": "base\n" });
    const base = (await git(repo, ["rev-parse", "HEAD"])).toString().trim();
    const head = await commitFiles(repo, { "value.txt": "head\n" });

    const twoDot = await resolveChangeSet(repo, {
      kind: "range",
      value: `${base}..${head}`,
    });
    const threeDot = await resolveChangeSet(repo, {
      kind: "range",
      value: `${base}...${head}`,
    });

    expect(twoDot).toMatchObject({ baseSha: base, headSha: head });
    expect(threeDot).toMatchObject({ baseSha: base, headSha: head });
  });

  test("fails invalid revisions and empty changes explicitly", async () => {
    const repo = await committedRepo({ "value.txt": "same\n" });

    await expect(
      resolveChangeSet(repo, { kind: "range", value: "missing..HEAD" }),
    ).rejects.toMatchObject({ code: "GIT_REF_INVALID" });
    await expect(
      resolveChangeSet(repo, { kind: "range", value: "HEAD..HEAD" }),
    ).rejects.toMatchObject({ code: "GIT_EMPTY_CHANGE" });
    await expect(
      resolveChangeSet(repo, { kind: "file", value: "../outside" }),
    ).rejects.toMatchObject({ code: "GIT_PATH_INVALID" });
  });

  test("rejects unresolved index conflicts instead of selecting one stage", async () => {
    const repo = await committedRepo({ "value.txt": "base\n" });
    const branch = (await git(repo, ["branch", "--show-current"]))
      .toString()
      .trim();
    await git(repo, ["checkout", "-b", "other"]);
    await commitFiles(repo, { "value.txt": "other\n" });
    await git(repo, ["checkout", branch]);
    await commitFiles(repo, { "value.txt": "main\n" });
    await expect(git(repo, ["merge", "other"])).rejects.toThrow();

    await expect(
      resolveChangeSet(repo, { kind: "working-tree" }),
    ).rejects.toMatchObject({ code: "GIT_CONFLICT_UNSUPPORTED" });
  });

  test("captures symlink text without reading or later re-reading its target", async () => {
    const repo = await committedRepo({ "base.txt": "base\n" });
    await symlink("first-target", path.join(repo, "link"));
    const change = await resolveChangeSet(repo, { kind: "working-tree" });
    await rm(path.join(repo, "link"));
    await symlink("second-target", path.join(repo, "link"));
    const work = path.join(await makeTempDir(), "sandbox");

    await materializeChangeSet(change, work);

    await expect(readlink(path.join(work, "link"))).resolves.toBe(
      "first-target",
    );
  });

  symlinkTest(
    "never follows a materialized parent symlink while applying a file overlay",
    async () => {
      const victim = await makeTempDir();
      await writeFile(path.join(victim, "child.txt"), "keep\n");
      const repo = await committedRepo({ "base.txt": "base\n" });
      await symlink(victim, path.join(repo, "link"));
      await git(repo, ["add", "link"]);
      await git(repo, ["commit", "-m", "add link"]);
      await rm(path.join(repo, "link"));
      await mkdir(path.join(repo, "link"));
      await writeFile(path.join(repo, "link/child.txt"), "overlay\n");

      const change = await resolveChangeSet(repo, {
        kind: "file",
        value: "link/child.txt",
      });
      const work = path.join(await makeTempDir(), "sandbox");
      await materializeChangeSet(change, work);

      await expect(
        readFile(path.join(victim, "child.txt"), "utf8"),
      ).resolves.toBe("keep\n");
      await expect(
        readFile(path.join(work, "link/child.txt"), "utf8"),
      ).resolves.toBe("overlay\n");
    },
  );

  test("captures an initialized submodule HEAD change", async () => {
    const sub = await committedRepo({ "value.txt": "one\n" });
    const oldOid = (await git(sub, ["rev-parse", "HEAD"])).toString().trim();
    const newOid = await commitFiles(sub, { "value.txt": "two\n" });
    const repo = await committedRepo({ "base.txt": "base\n" });
    await git(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      sub,
      "sub",
    ]);
    await git(path.join(repo, "sub"), ["checkout", oldOid]);
    await git(repo, ["add", ".gitmodules", "sub"]);
    await git(repo, ["commit", "-m", "add submodule"]);
    await git(path.join(repo, "sub"), ["checkout", newOid]);

    const change = await resolveChangeSet(repo, { kind: "working-tree" });

    expect(change.diff.changedFiles).toEqual([{ status: "M", paths: ["sub"] }]);
    expect(change.diff.patch).toContain(`-Subproject commit ${oldOid}`);
    expect(change.diff.patch).toContain(`+Subproject commit ${newOid}`);
  });

  test("does not mistake a deinitialized submodule for the superproject", async () => {
    const sub = await committedRepo({ "value.txt": "one\n" });
    const repo = await committedRepo({ "base.txt": "base\n" });
    await git(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      sub,
      "sub",
    ]);
    await git(repo, ["commit", "-am", "add submodule"]);
    await git(repo, ["submodule", "deinit", "-f", "sub"]);
    await writeFile(path.join(repo, "base.txt"), "changed\n");

    const change = await resolveChangeSet(repo, { kind: "working-tree" });

    expect(change.diff.changedFiles).toEqual([
      { status: "M", paths: ["base.txt"] },
    ]);
  });

  test("reports dirty files inside an initialized submodule", async () => {
    const sub = await committedRepo({ "value.txt": "one\n" });
    const oid = (await git(sub, ["rev-parse", "HEAD"])).toString().trim();
    const repo = await committedRepo({ "base.txt": "base\n" });
    await git(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      sub,
      "sub",
    ]);
    await git(repo, ["commit", "-am", "add submodule"]);
    await writeFile(path.join(repo, "sub/value.txt"), "dirty\n");

    const change = await resolveChangeSet(repo, { kind: "working-tree" });

    expect(change.diff.changedFiles).toEqual([{ status: "M", paths: ["sub"] }]);
    expect(change.diff.patch).toContain(`+Subproject commit ${oid}-dirty`);
    expect(snapshotChangeSet(change).overlay).toEqual([
      {
        path: "sub",
        entry: { kind: "gitlink", oid, mode: 0o160000, dirty: true },
      },
    ]);
  });

  test("never runs checkout hooks, clean filters, smudge filters, or diff drivers", async () => {
    const repo = await committedRepo({
      ".gitattributes": "*.txt filter=hostile diff=hostile\n",
      "tracked.txt": "old\n",
      "mark-filter.cjs": markerScript("filter-ran"),
      "mark-diff.cjs": markerScript("diff-ran"),
    });
    await git(repo, ["config", "filter.hostile.clean", "node mark-filter.cjs"]);
    await git(repo, [
      "config",
      "filter.hostile.smudge",
      "node mark-filter.cjs",
    ]);
    await git(repo, ["config", "diff.hostile.command", "node mark-diff.cjs"]);
    const hooks = (await git(repo, ["rev-parse", "--git-path", "hooks"]))
      .toString()
      .trim();
    const hook = path.join(repo, hooks, "post-checkout");
    await writeFile(
      hook,
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync('checkout-ran', 'yes');\n",
    );
    await chmod(hook, 0o755);
    await rm(path.join(repo, "filter-ran"), { force: true });
    await writeFile(path.join(repo, "tracked.txt"), "new\n");

    const beforeIndex = await readFile(path.join(repo, ".git/index"));
    const change = await resolveChangeSet(repo, { kind: "working-tree" });
    const work = path.join(await makeTempDir(), "sandbox");
    await materializeChangeSet(change, work);

    await expect(readFile(path.join(repo, ".git/index"))).resolves.toEqual(
      beforeIndex,
    );
    for (const marker of ["checkout-ran", "filter-ran", "diff-ran"]) {
      await expect(readFile(path.join(repo, marker))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
});

function markerScript(marker: string) {
  return `const fs=require('node:fs');fs.writeFileSync('${marker}','yes');process.stdin.pipe(process.stdout);\n`;
}
