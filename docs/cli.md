# ChangeForge CLI guide

This guide covers every supported CLI workflow. Run `changeforge <command> --help` for the installed version's exact flags.

## Setup

```bash
npm install -g changeforge
cd your-repository
changeforge init
changeforge login
changeforge doctor
```

`init` creates `.changeforge/config.json` and adds generated output directories to `.gitignore`. Commit the config; do not commit `.changeforge/runs/` or `changeforge/<run-id>/`.

## Commands

| Command   | Purpose                                                      |
| --------- | ------------------------------------------------------------ |
| `init`    | Create strict repository configuration                       |
| `login`   | Authenticate the installed Codex CLI                         |
| `doctor`  | Check tools, authentication, project detection, and browsers |
| `run`     | Resolve and review one immutable change                      |
| `inspect` | Verify and display a persisted run without executing code    |
| `execute` | Execute a stored plan in a fresh temporary checkout          |
| `apply`   | Apply one verified generated sidecar                         |
| `report`  | Print or open a run's native Playwright HTML report          |
| `clean`   | Remove inactive machine and public run evidence              |

Global `--help` and `--version` are also available.

## Initialize and authenticate

```bash
# Initialize the current repository.
changeforge init

# Initialize a repository from another directory.
changeforge init --repo ../app

# Replace existing ChangeForge configuration.
changeforge init --force

# Interactive or device authentication.
changeforge login
changeforge login --device-auth

# Check Codex authentication only.
changeforge login --status
```

ChangeForge delegates authentication to Codex and never reads or stores Codex credentials.

## Diagnose the environment

```bash
changeforge doctor
changeforge doctor --repo ../app
changeforge doctor --json
```

Doctor checks Git, Node.js, npm, Codex, Codex authentication, repository detection, package manager, and Playwright. When Playwright is installed, it prints package-manager-specific browser verification and installation commands.

## Choose one change

Every `run` requires exactly one input.

| Input           | Example               | Meaning                                                   |
| --------------- | --------------------- | --------------------------------------------------------- |
| Three-dot range | `--range main...HEAD` | Merge base to head; usually best for a feature branch     |
| Two-dot range   | `--range main..HEAD`  | Exact left revision to right revision                     |
| Commit          | `--commit HEAD`       | Commit versus its parent, or empty tree for a root commit |
| File            | `--file src/auth.ts`  | One repository-relative path from the current checkout    |
| Working tree    | `--working-tree`      | Captured staged, unstaged, and untracked changes          |

Use `--repo <path>` on any repository command to target a different checkout.

## Run recipes

### Review only

```bash
changeforge run --range main...HEAD
```

This captures the change, sends its review context to Codex, validates `findings.v1.json`, and writes evidence. It does not run project commands.

### Generate without execution

```bash
changeforge run --range main...HEAD --generate
```

Codex may create one run-scoped Playwright sidecar. The sidecar is validated and stored, but never executed or copied into the checkout.

### Execute existing tests

```bash
# Run detected test phases.
changeforge run --range main...HEAD --execute

# Run unit tests only.
changeforge run --range main...HEAD \
  --execute \
  --no-playwright
```

Execution checkouts link the repository's existing `node_modules`, so normal local runs do not install anything. Install dependencies in the source repository first. `--install-deps` replaces reuse with a fresh lifecycle-script-free install; npm audit and funding checks are disabled. Playwright browser binaries remain a separate prerequisite.

The reused dependency tree is writable by trusted commands. Use `--install-deps` when dependency mutations must remain inside the temporary checkout.

Projects requiring explicit generation can configure or override a trusted setup command:

```bash
changeforge run --file src/api.ts --execute \
  --setup-command 'npm exec --offline --yes=false -- prisma generate'
```

Setup runs after dependency preparation and before tests, including each differential side. It requires execution consent and may only change dependencies or owned runtime output.

### Generate and execute

```bash
changeforge run --range main...HEAD \
  --generate \
  --execute
```

Generation makes one Codex attempt. ChangeForge does not automatically repair a rejected generated sidecar or retry a failed Playwright run. A resumed `execute` uses the stored plan without calling Codex.

### Differential proof

```bash
changeforge run --range main...HEAD \
  --generate \
  --execute \
  --differential
```

Differential verification requires:

- `--generate`
- Playwright enabled and available
- both `webServer.command` and `webServer.url` configured
- the direct engine-built Playwright command

A custom `playwrightCommand` cannot establish differential proof.

### Inspect before execution

```bash
# Review, generate, and persist the differential plan.
changeforge run --range main...HEAD --generate --differential

# Verify findings, sidecar, commands, capabilities, and artifact digests.
changeforge inspect --run <run-id>

# Execute the stored plan without calling Codex again.
changeforge execute --run <run-id>

# Inspect the final evidence, then apply only the sidecar.
changeforge inspect --run <run-id>
changeforge apply --run <run-id>
```

Use JSON for automation:

```bash
changeforge inspect --run <run-id> --json
```

`--force` on `execute` or `apply` repeats completed work or recovers a stale crashed phase. It never bypasses source, preimage, or digest checks.

### Keep the temporary checkout

```bash
changeforge run --working-tree --generate --execute --keep-sandbox
```

The generation/execution checkout is retained and its path is printed. The independent read-only review checkout is always removed.

### Select a model or phase

```bash
changeforge run --commit HEAD --model <model>
changeforge run --commit HEAD --execute --no-unit
changeforge run --commit HEAD --execute --no-playwright
```

`--allow-source-edits` is a legacy unsupported option. Generation is restricted to one new sidecar.

## Trusted custom commands

Command-line overrides take precedence over configuration:

```bash
changeforge run --range main...HEAD \
  --execute \
  --unit-command 'npm run test:unit'

changeforge run --range main...HEAD \
  --generate \
  --execute \
  --playwright-command 'npm exec -- playwright test {testFile} --reporter=html'
```

For generated coverage, a custom Playwright command must contain the literal `{testFile}` placeholder. Custom commands are shell strings and must be treated as trusted code. They run only with execution consent.

ChangeForge supplies `PLAYWRIGHT_HTML_OPEN=never` and `PLAYWRIGHT_HTML_OUTPUT_DIR` to Playwright. A custom `playwrightCommand` must enable Playwright's HTML reporter and preserve those environment values; otherwise `summary.json` records `playwrightReport` as `null`. The built-in direct command forces `--reporter=html`, which overrides reporters configured by the project for that invocation.

Default unit detection prefers a `test` package script, then `test:unit`. Playwright runs only when its target, dependencies, and configuration are available.

## Inspect, execute, and apply

```bash
changeforge inspect --run <run-id> [--repo <path>] [--json]
changeforge execute --run <run-id> [--repo <path>] [--install-deps] [--force]
changeforge apply --run <run-id> [--repo <path>] [--force]
```

- `inspect` validates recorded core artifact digests and reports surviving evidence plus individual integrity errors.
- `execute` rematerializes the stored snapshot and overlay in a fresh checkout, then runs the frozen plan.
- `apply` verifies the current source and generated-file preimage, writes only the approved sidecar, and never stages or commits.

Do not hand-edit `.changeforge/runs/<run-id>`. Create a new run if persisted evidence is damaged.

## Reports

```bash
# Print the newest report path.
changeforge report --no-open

# Print or open a specific run.
changeforge report --run <run-id> --no-open
changeforge report --run <run-id> --open
```

When Playwright emits its native HTML output, ChangeForge retains it on both passing and failing runs at:

```text
changeforge/<run-id>/playwright-report/index.html
```

`report --open` opens that file and prints its path; `--no-open` only prints the path. Without `--run`, the newest public run is selected. If the selected run has no Playwright HTML report, the command prints its public `code-review.md` path. If neither exists, it fails.

## Cleanup

```bash
changeforge clean [--repo <path>] [--run <run-id>] [--keep <number>] [--dry-run]
```

- With no selector, remove all inactive persisted runs.
- `--keep 10` retains and compacts the newest ten; the same retention runs automatically after each verification.
- `--run` removes one machine/public evidence pair.
- `--dry-run` prints pending compactions and deletions without changing files.
- Active runs are skipped. Applied tests outside the public run directory are never removed.
- Marked public run folders left without machine evidence by older versions are included.

After every initial or resumed operation, terminal runs are compacted to `run-manifest.v1.json` and `artifacts/immutable/`. Raw context, prompts, Codex output, logs, mutable artifact copies, and empty lock directories are removed. Active, running, malformed, and incomplete runs remain intact for recovery. The public code review, generated sidecars, and Playwright HTML survive for the newest ten runs; older machine/public pairs are removed together.

## Configuration

`changeforge init` writes these defaults:

```json
{
  "docsDir": "changeforge",
  "testsDir": "changeforge/{runId}",
  "allowSourceEdits": false,
  "commandTimeoutMs": 600000,
  "setupCommand": null,
  "unitCommand": null,
  "playwrightCommand": null,
  "webServer": {
    "command": null,
    "url": null,
    "timeoutMs": 120000
  },
  "codex": {
    "adapter": "cli",
    "reasoning": "low",
    "stream": false,
    "ignoreRules": false,
    "timeoutMs": 300000,
    "reviewSystemPrompt": null,
    "testGenerationSystemPrompt": null
  },
  "playwright": {
    "enabled": true,
    "preferStableLocators": true,
    "testFocus": "edge-cases",
    "e2eTestPath": null
  }
}
```

Key rules:

- `webServer.command` and `webServer.url` must be set together.
- `testsDir` requires `{runId}` as a complete path segment.
- `docsDir` must be a stable root without `{runId}`.
- `playwright.e2eTestPath` is reference material; generation always writes a new sidecar.
- `setupCommand` is a trusted post-dependency command and runs only with execution consent.
- `playwright.testFocus` accepts `edge-cases` or `full`.
- `codex.reasoning` accepts `low`, `medium`, `high`, or `xhigh`.
- Unknown keys, wrong types, absolute or escaping paths, reserved metadata, output overlaps, and symlink traversal fail validation.

For compatibility, retired report-generator, `reviewDocPath`, and automatic-repair keys in legacy config files and v1 run manifests are accepted and ignored. They are not written by `init`, exposed as options, or executed when a stored plan resumes.

## Artifacts

Default public output:

```text
changeforge/<run-id>/
  code-review.md
  test-edge-cases.spec.ts       # when generated without an E2E reference
  playwright-report/            # when Playwright emits native HTML
    index.html
```

Retained terminal machine output:

```text
.changeforge/runs/<run-id>/
  run-manifest.v1.json
  artifacts/
    immutable/<artifact-name>/<sha256>.blob
```

Some immutable artifacts exist only when their phase runs. `inspect`, resumed `execute`, and `apply` verify these blobs through the manifest; readable public output remains under `changeforge/<run-id>/`.

## Status and exits

| Status    | Meaning                                                                    | Exit code |
| --------- | -------------------------------------------------------------------------- | --------- |
| `passed`  | A trusted unit or Playwright test ran and every final command passed       | `0`       |
| `partial` | Review completed, but no trusted test ran or verification was incomplete   | `0`       |
| `failed`  | A command, required stage, integrity guard, or differential verdict failed | `1`       |

`partial` includes review-only runs, unavailable coverage, missing submodules, and `no-discrimination` differential results. `doctor` exits `1` for failed checks; `inspect` exits `1` for integrity errors.

## Safety

ChangeForge protects the source checkout, not the host:

- Temporary checkouts do not inherit repository Git metadata. Execution reuses local `node_modules` through a dependency link unless `--install-deps` is requested.
- `--execute`, dependency installation, and configured web servers run as ordinary host processes with inherited environment and network access.
- Review sends captured change context through Codex.
- Secret redaction, context preview, and a hermetic container executor are not implemented.

Only execute trusted repositories, configuration, and commands.

## Troubleshooting

| Problem                                      | Fix                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ChangeForge config not found`               | Run `changeforge init`                                                                                    |
| Codex missing or unauthenticated             | Install/update Codex, then run `changeforge login` and `changeforge doctor`                               |
| Input contains no changes                    | Select a nonempty range, commit, file, or working tree                                                    |
| `GIT_HISTORY_SHALLOW`                        | Fetch enough Git history for the selected commit or range                                                 |
| Playwright unavailable                       | Declare/install `@playwright/test` and configure an E2E reference or web server                           |
| Local dependencies missing                   | Run the repository package-manager install locally, or pass `--install-deps`                              |
| Generated dependency missing                 | Configure `setupCommand`, for example an offline `prisma generate` command                                |
| Browser executable missing                   | Run the browser command printed by `changeforge doctor`                                                   |
| Custom generated Playwright command rejected | Include literal `{testFile}`                                                                              |
| Differential prerequisites rejected          | Enable Playwright, configure the web server pair, remove custom Playwright commands, and use `--generate` |
| Source/input mutation                        | Make the test command write only runtime output to supported output directories                           |
| Artifact integrity error                     | Do not use `--force` to bypass it; create a clean new run                                                 |

For boundary details, see [ARCHITECTURE.md](../ARCHITECTURE.md).
