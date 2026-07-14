# ChangeForge Architecture

ChangeForge is a local TypeScript change-verification engine. It resolves one Git change, reviews it without mutating the checkout, optionally generates one Playwright sidecar, and can prove whether that sidecar distinguishes base from head.

## Pipeline

```text
strict input/config
  -> immutable change resolution
  -> external head sandbox
  -> deterministic context
  -> independent read-only Codex review sandbox
  -> validated findings.v1.json + rendered Markdown
  -> optional strict sidecar generation
  -> frozen source/config/sidecar manifest
  -> optional guarded unit + Playwright execution
  -> optional base/head differential verification
  -> summary, patch, and content-addressed evidence
  -> sandbox cleanup
```

The checkout provides Git objects and captured working-tree bytes. Review and execution use separate private OS temporary directories with no inherited `.git`. Execution links the source repository's existing dependency tree by default; `--install-deps` builds a new one. The execution boundary is `checkout-isolated`, not hermetic.

The fast dependency link is intentionally writable, so trusted setup/tests can update the source repository's local dependency tree. Fresh install mode keeps those dependency writes in the temporary head checkout. Differential sides share one prepared tree and therefore treat dependency/setup behavior as trusted infrastructure, not immutable evidence.

## Git boundary

Refs become immutable object IDs before later work. Three-dot ranges use their merge base. Commit parents are parsed from commit objects: no parent header means a root commit; a referenced but missing parent is `GIT_HISTORY_SHALLOW`, never an empty-tree comparison.

Dirty and file inputs capture exact tracked, staged, unstaged, untracked, link, and mode state. Materialization uses `git ls-tree` and `git cat-file`, not checkout, worktree, archive, hooks, filters, or the project index. Repository symlinks are recreated without being followed. Missing changed submodules remain explicit coverage gaps.

## Codex and generated-code boundary

Review uses `codex exec --ephemeral` in a read-only sandbox. Its JSON output is strictly parsed into `findings.v1.json`; Markdown is rendered from that canonical document.

Generation receives a staging workspace containing only a new run-scoped sidecar. Broader source edits are unsupported. The TypeScript policy rejects process, environment, filesystem, direct network, runtime-module recovery, dynamic loading, skipped tests, placeholders, and imports other than `@playwright/test`. A configured E2E test is read-only reference material, never the generation target. Generation and execution failures do not trigger an automatic Codex repair pass.

## Command boundary

Internally built commands use executable-plus-argument arrays. Only configured command strings use a shell, and only after `--execute`. Existing local dependencies are linked without installation. Fresh installation requires `--install-deps`, disables lifecycle scripts and npm audit/funding work, and triggers project redetection. An optional trusted setup command runs afterward and before tests.

Before the first project command, ChangeForge freezes all materialized source, configuration, lockfile, and sidecar bytes. It checks them before and after each command. Installed dependencies and owned `.changeforge-runtime` output are excluded. Unexpected mutation fails execution even when the command exits zero. The frozen sidecar is not rewritten after generation.

## Differential boundary

Differential mode requires generated evidence and a configured web server. The current head sandbox and a fresh base sandbox receive identical sidecar bytes. Base must match the stored sidecar preimage before replay.

Both sides use an engine-owned minimal Playwright config with root-specific paths, `reuseExistingServer: false`, an exact test list, `--no-deps`, no retries, one worker, isolated output, and JSON reporting. They reuse one prepared dependency tree and run trusted setup immediately before each side. Project Playwright config, custom Playwright commands, global setup, and unrelated specs cannot establish proof. Reports are bound to the expected generated path; contradictory status/error data and infrastructure failures are invalid.

```text
base fail + head pass -> regression-proof
base pass + head pass -> no-discrimination (partial)
base pass + head fail -> regression-detected (failed)
base fail + head fail -> invalid (failed)
```

Configured web-server commands still run on the host with inherited environment and network access, so differential execution remains checkout-isolated rather than hermetic.

## Filesystem and evidence boundary

Contained I/O rejects absolute/escaping paths, unsafe run IDs, reserved metadata, and symlinked components. Writes use exclusive temporary files, `fsync`, and atomic rename.

```text
.changeforge/runs/<run-id>/
  run-manifest.v1.json
  artifacts/
    immutable/<artifact-name>/<sha256>.blob

changeforge/<run-id>/
  code-review.md
  test-edge-cases.spec.ts
  playwright-report/
    index.html
```

Manifest updates use revision compare-and-swap under a run lock. Artifacts are staged at content-addressed immutable paths before the new manifest revision is published. A crash or competing writer cannot retarget existing evidence.

The public run folder is intentional readable evidence: `code-review.md`, an optional generated Playwright spec, and an optional native HTML report. When Playwright emits its report, ChangeForge copies it to `changeforge/<run-id>/playwright-report/index.html` before sandbox cleanup, regardless of the Playwright exit status. Built-in direct execution forces `--reporter=html`, overriding project-configured reporters. Custom `playwrightCommand` strings receive the HTML output environment variables but must enable or forward the HTML reporter themselves; otherwise no report is published and `playwrightReport` is `null`. A forced rerun clears the previous public report before publishing new output.

Patch creation compares byte/link manifests through a private Git object database and index. It never runs `git add` or uses the project index. Runtime and dependency paths are excluded.

## Resumable lifecycle

- `inspect` validates every recorded digest without executing project code.
- `execute` restores the checksummed change and generated overlay in a fresh sandbox without invoking Codex.
- `apply` verifies checkout provenance and generated-path preimages, then copies only the sidecar without staging it.
- `--force` can repeat completed work or recover stale crash states, but cannot bypass source or artifact checks.

Run and manifest locks prevent live writers from racing. Phase attempts and failure reasons are persisted. Inspection returns surviving evidence plus per-artifact integrity errors when a run is torn or damaged.

Retired report-generator and automatic-repair keys in stored configuration or manifests are accepted and discarded during validation. Resume cannot execute them.

Run-operation locks live outside deletable evidence directories. After the lock is released, cleanup compacts terminal retained runs to their manifest and immutable blobs, removes empty lock directories, and skips active or incomplete runs. Automatic retention keeps the newest ten machine/public pairs and deletes older pairs; explicit `clean --run`, `clean --keep`, and `clean --dry-run` provide intentional retention control.

## Status model

- `passed`: a trusted test ran, final commands succeeded, and requested differential proof is valid.
- `partial`: no trusted test ran, coverage is unavailable, a submodule is missing, or differential coverage does not discriminate.
- `failed`: a required stage/command failed, inputs changed, differential found a head regression, or differential evidence is invalid.

The native Playwright HTML report is diagnostic output and cannot change run status.

## Entry points

- `src/index.ts`: side-effect-free library API and v1 schemas.
- `src/cli.ts`: Commander program construction.
- `src/bin.ts`: the only import-time caller of `main`.
- `src/core/`: config, schemas, manifests, immutable artifact storage.
- `src/git/`: resolution, snapshots, materialization, overlays, patches.
- `src/pipeline/`: review, generation, execution, differential proof, summaries.
- `src/commands/`: CLI adapters.
