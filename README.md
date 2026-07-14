# ChangeForge

**ChangeForge is a local change-verification engine for JavaScript and TypeScript repositories.** It captures one Git change, asks Codex for structured findings, optionally generates a Playwright sidecar, and can prove that the test fails on the base revision and passes on the head revision.

[CLI guide](docs/cli.md) · [Library API](docs/library.md) · [Architecture](ARCHITECTURE.md) · [Roadmap](todo.md)

> **Project status:** v0.1 preview. ChangeForge is designed for trusted local repositories. Its temporary checkouts isolate files, but command execution is not a container or security sandbox.

## Why ChangeForge?

| Question                                   | Evidence ChangeForge produces                                       |
| ------------------------------------------ | ------------------------------------------------------------------- |
| What exactly was reviewed?                 | An immutable, checksummed Git change snapshot                       |
| What did the reviewer find?                | Validated `findings.v1.json` plus readable Markdown                 |
| Does the generated test verify the change? | Optional base-fail/head-pass differential proof                     |
| Can I inspect before trusting code?        | Persisted plans, generated overlays, commands, and artifact digests |

Use it when a normal AI review is too hard to audit, or when “a test was generated” is weaker than “this test distinguishes the change.”

## Quick start

### Requirements

- Node.js 20.19.0 or newer
- Git
- A current, authenticated Codex CLI
- A JavaScript or TypeScript repository with `package.json`

### Install

```bash
npm install -g changeforge
```

From a cloned source checkout:

```bash
npm ci
npm run build
npm link
```

### Review a branch

```bash
cd your-repository
changeforge init
changeforge login
changeforge doctor
changeforge run --range main...HEAD
```

The run prints its ID and status. Review-only runs normally finish as `partial` because no trusted test command ran.

```text
changeforge/<run-id>/
  code-review.md
  test-edge-cases.spec.ts       # when --generate is used
  playwright-report/
    index.html

.changeforge/runs/<run-id>/
  run-manifest.v1.json
  artifacts/immutable/
```

`changeforge/<run-id>/playwright-report/index.html` is present when Playwright emits its native HTML report. ChangeForge copies it before removing the temporary checkout on both passing and failing runs; otherwise the summary records `playwrightReport: null`.

`code-review.md` is the only generated Markdown report. Raw diff, prompt, Codex, and command evidence is removed after the run; verified resumable evidence remains under `artifacts/immutable/`. Generated Playwright coverage is published as a `.spec.ts` file.

## Permission model

`changeforge run` is review-only unless you grant additional capabilities.

| Permission                 | What it allows                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------- |
| No flag                    | Resolve the change, write evidence, and send review context to Codex                |
| `--generate`               | Let Codex create one validated Playwright sidecar in a temporary workspace          |
| `--execute`                | Run trusted setup, test, and web-server commands in the temporary checkout          |
| `--differential`           | Plan or run the generated sidecar against both base and head; requires `--generate` |
| `--install-deps --execute` | Replace local dependency reuse with a fresh lifecycle-script-free install           |
| `changeforge apply`        | Copy only a verified generated sidecar into the current checkout                    |

`--generate` never implies `--execute`. `--execute` never grants Codex write access. ChangeForge never stages, commits, or pushes.

## Common workflows

Choose exactly one change input:

```bash
changeforge run --range main...HEAD
changeforge run --commit HEAD
changeforge run --file src/auth/session.ts
changeforge run --working-tree
```

Generate coverage without running project code:

```bash
changeforge run --range main...HEAD --generate
```

Run existing unit tests without generation. The temporary checkout reuses local `node_modules`:

```bash
changeforge run --range main...HEAD --execute --no-playwright
```

Generate and execute one validated Playwright sidecar:

```bash
changeforge run --range main...HEAD --generate --execute
```

ChangeForge does not ask Codex to repair policy-rejected generation or failing Playwright execution. Those failures remain evidence for the run.

Require base-fail/head-pass proof:

```bash
changeforge run --range main...HEAD --generate --execute --differential
```

Inspect before execution or application:

```bash
changeforge run --range main...HEAD --generate --differential
changeforge inspect --run <run-id>
changeforge execute --run <run-id>
changeforge inspect --run <run-id>
changeforge apply --run <run-id>
```

Print or open a native Playwright report. Omitting `--run` selects the newest public run:

```bash
changeforge report --run <run-id>
changeforge report --run <run-id> --open
```

If the run has no HTML report, the command prints its public `code-review.md` path instead. If neither exists, it fails.

Clean persisted evidence:

```bash
changeforge clean --dry-run
changeforge clean --keep 10
changeforge clean --run <run-id>
```

ChangeForge automatically keeps the newest ten runs. Each retained terminal machine run is compacted to its manifest and immutable blobs; raw context, prompts, Codex output, logs, mutable artifact copies, and empty lock directories are removed. Older machine/public pairs are deleted together. Active and incomplete runs are left intact for recovery, and applied sidecars outside the public run directory are never removed. `--dry-run` previews both compaction and deletion.

`execute` restores the stored change in a fresh checkout and does not call Codex again. `apply` verifies the source revision and generated-file preimage before writing one sidecar.

See the [CLI guide](docs/cli.md) for every command, custom commands, phase selection, reports, configuration, and troubleshooting.

## Differential verification

Differential mode runs the exact frozen sidecar bytes against base and head. It requires:

- `--generate` and Playwright enabled
- `webServer.command` and `webServer.url` in configuration
- direct Playwright execution; custom Playwright shell commands cannot establish proof

| Base | Head | Classification        | Status    |
| ---- | ---- | --------------------- | --------- |
| Fail | Pass | `regression-proof`    | Accepted  |
| Pass | Pass | `no-discrimination`   | `partial` |
| Pass | Fail | `regression-detected` | `failed`  |
| Fail | Fail | `invalid`             | `failed`  |

Setup errors, retries, flaky or skipped tests, unrelated specs, timeouts, and source mutation are invalid evidence.

## Library

Install locally in another Node.js project:

```bash
npm install changeforge
```

The high-level API mirrors the safe CLI workflow:

```ts
import { applyRun, executeRun, inspectRun, runPipeline } from "changeforge";

try {
  const summary = await runPipeline({
    repo: process.cwd(),
    range: "main...HEAD",
    generate: true,
    differential: true,
  });

  const inspection = await inspectRun({
    repo: process.cwd(),
    runId: summary.runId,
  });

  if (inspection.integrityErrors.length === 0) {
    await executeRun({
      repo: process.cwd(),
      runId: summary.runId,
      installDeps: true,
    });

    const verified = await inspectRun({
      repo: process.cwd(),
      runId: summary.runId,
    });

    if (
      verified.integrityErrors.length === 0 &&
      verified.summary?.status === "passed"
    ) {
      await applyRun({ repo: process.cwd(), runId: summary.runId });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
}
```

Importing `changeforge` has no CLI side effects. Required-stage failures reject the promise; completed command or differential failures return a summary with `status: "failed"`. Review-only and generation-only runs normally return `partial`.

The [library guide](docs/library.md) covers all run modes, options, result handling, resumable APIs, structured findings, manifests, snapshots, overlays, and differential helpers.

## Configuration

`changeforge init` creates strict configuration at `.changeforge/config.json`. For differential verification, the smallest useful override is:

```json
{
  "webServer": {
    "command": "npm run dev",
    "url": "http://127.0.0.1:3000",
    "timeoutMs": 120000
  }
}
```

Unknown keys, invalid types, absolute or escaping paths, reserved metadata paths, overlapping outputs, and symlink traversal are rejected. Configured setup, unit, Playwright, and web-server strings are trusted shell commands and run only with execution consent. Use `setupCommand` for explicit generation such as `npm exec --offline --yes=false -- prisma generate`; local Prisma output is normally reused without running it.

Built-in direct Playwright execution appends `--reporter=html`, intentionally overriding reporters configured by the project. A custom `playwrightCommand` receives `PLAYWRIGHT_HTML_OUTPUT_DIR` and `PLAYWRIGHT_HTML_OPEN=never`, but must itself enable or forward the HTML reporter. If it does not produce `index.html` in that directory, the summary records `playwrightReport: null`.

For stored-run compatibility, retired report-generator and automatic-repair keys in configuration or manifests are accepted and ignored. They are not current options and are never executed.

See [Configuration](docs/cli.md#configuration) for every key and default.

## Results and exit status

Public, readable output is written under `changeforge/<run-id>/`. Machine evidence, prompts, logs, checksummed core artifacts, and the run manifest are written under `.changeforge/runs/<run-id>/`.

| Status    | Meaning                                                                    | CLI exit |
| --------- | -------------------------------------------------------------------------- | -------- |
| `passed`  | At least one trusted test ran and final commands succeeded                 | `0`      |
| `partial` | Review completed but proof or executable coverage is incomplete            | `0`      |
| `failed`  | A command, integrity check, required stage, or differential verdict failed | `1`      |

`doctor` exits nonzero when a prerequisite fails. `inspect` exits nonzero when artifact integrity errors are found.

Native HTML availability is diagnostic and does not change the run status.

## Trust boundaries

- Review and execution use separate OS temporary directories without inherited `.git`. Execution links existing local `node_modules`; use `--install-deps` only for a fresh dependency tree.
- Reused dependencies are writable by trusted project/setup commands. Use `--install-deps` when a run must not mutate the source repository's local dependency tree.
- This is **checkout isolation, not hermetic execution**. Tests, installs, and web servers are ordinary host processes with the current user's permissions, environment, and network access.
- Only use `--execute` with trusted repositories, configuration, and commands.
- Review sends captured change context through the installed Codex CLI. Secret redaction and context preview are not implemented yet.
- Generated Playwright code is restricted to one sidecar and checked for unsafe APIs, skips, placeholders, and unrelated imports.
- ChangeForge leaves inspected source and Git state untouched, but intentionally writes declared evidence directories to the repository.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the complete Git, Codex, command, filesystem, and evidence boundaries.

## Current scope

- Local JavaScript and TypeScript repositories
- npm, pnpm, and Yarn project detection
- Playwright as the first generated validator
- Codex CLI as the review and generation adapter
- No GitHub Action, SARIF policy gate, unified report, context preview, or container executor yet

The prioritized next phases are tracked in [todo.md](todo.md).

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
```

Contributions should preserve explicit consent, checkout immutability, strict artifact validation, and cross-platform behavior.

## License

[MIT](LICENSE)
