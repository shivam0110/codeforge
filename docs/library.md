# ChangeForge library API

ChangeForge exposes a side-effect-free ESM entrypoint for Node.js 20.19 or newer.

```bash
npm install changeforge
```

Use the workflow API for applications. The artifact and engine helpers are advanced v0.1 APIs and may change before a stable release.

## Workflow API

### Review one change

```ts
import { runPipeline } from "changeforge";

const summary = await runPipeline({
  repo: process.cwd(),
  range: "main...HEAD",
});
```

Exactly one input is required:

```ts
await runPipeline({ repo, range: "main...HEAD" });
await runPipeline({ repo, commit: "HEAD" });
await runPipeline({ repo, file: "src/auth/session.ts" });
await runPipeline({ repo, workingTree: true });
```

### Select a run mode

```ts
const repo = process.cwd();
const range = "main...HEAD";

// Review only.
await runPipeline({ repo, range });

// Generate one sidecar; do not execute it.
await runPipeline({ repo, range, generate: true });

// Execute detected existing tests; do not generate.
await runPipeline({ repo, range, execute: true });

// Execute unit tests only.
await runPipeline({
  repo,
  range,
  execute: true,
  playwright: false,
});

// Generate and execute one validated sidecar.
await runPipeline({
  repo,
  range,
  generate: true,
  execute: true,
});

// Prove the generated sidecar against base and head.
await runPipeline({
  repo,
  range,
  generate: true,
  execute: true,
  differential: true,
});
```

Review-only and generation-only runs normally return `status: "partial"` because no trusted test command ran.

Generation and Playwright execution are single-attempt operations. ChangeForge does not ask Codex to repair a rejected or failing test automatically; fix the inputs or configuration and start a new run.

### Install dependencies

Normal execution reuses the repository's existing `node_modules`. Opt into a fresh install only when needed:

```ts
await runPipeline({
  repo,
  range,
  execute: true,
  installDeps: true,
});
```

Installation requires execution consent, a supported npm/pnpm/Yarn project, and disables lifecycle scripts. Playwright browser installation is separate.

Use a trusted setup command for explicit generated dependencies:

```ts
await runPipeline({
  repo,
  range,
  execute: true,
  setupCommand: "npm exec --offline --yes=false -- prisma generate",
});
```

### Use trusted custom commands

```ts
await runPipeline({
  repo,
  range,
  generate: true,
  execute: true,
  unitCommand: "npm run test:unit",
  playwrightCommand: "npm exec -- playwright test {testFile} --reporter=html",
});
```

Custom commands are shell strings. For generated coverage, `playwrightCommand` must include `{testFile}`. It must also enable or forward Playwright's HTML reporter; ChangeForge supplies its output-directory environment variables but does not rewrite a custom command. Without an HTML report, `summary.playwrightReport` is `null`. Differential verification rejects custom Playwright commands.

The built-in direct command always adds `--reporter=html`. This guarantees the native report but overrides reporters configured by the project for that invocation.

### Plan now, execute later

```ts
import { executeRun, inspectRun, runPipeline } from "changeforge";

const planned = await runPipeline({
  repo,
  range,
  generate: true,
  differential: true,
});

const before = await inspectRun({ repo, runId: planned.runId });
if (before.integrityErrors.length > 0) {
  throw new Error("Stored run evidence failed integrity checks.");
}

await executeRun({
  repo,
  runId: planned.runId,
});

const after = await inspectRun({ repo, runId: planned.runId });
```

`executeRun` restores the stored snapshot and generated overlay in a fresh checkout. It runs the frozen plan without invoking Codex or modifying generated code.

### Apply the approved sidecar

```ts
import { applyRun } from "changeforge";

const result = await applyRun({ repo, runId });
// result.status is "applied" or "already-applied".
```

`applyRun` verifies artifact digests, source provenance, and the generated path's preimage. It writes only the overlay and never stages, commits, or pushes.

`force: true` may repeat completed work or recover a stale crashed phase. It never bypasses integrity checks.

## Run options

| Option                                   | Purpose                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| `repo`                                   | Repository or path inside it; defaults to `process.cwd()` |
| `range`, `commit`, `file`, `workingTree` | Exactly one immutable change input                        |
| `generate`                               | Authorize one generated Playwright sidecar                |
| `execute`                                | Authorize project and configured commands                 |
| `differential`                           | Plan or run base/head proof; requires `generate`          |
| `installDeps`                            | Install dependencies; requires `execute`                  |
| `unit`, `playwright`                     | Set to `false` to disable a phase                         |
| `setupCommand`                           | Trusted command after dependency preparation              |
| `unitCommand`, `playwrightCommand`       | Trusted shell command overrides                           |
| `model`                                  | Codex model override                                      |
| `keepSandbox`                            | Retain the generation/execution temporary checkout        |

`allowSourceEdits` is legacy and generation rejects it.

Differential mode also requires Playwright enabled and available plus configured `webServer.command` and `webServer.url`.

## Results and errors

`RunSummary` includes:

| Field                                       | Meaning                                                  |
| ------------------------------------------- | -------------------------------------------------------- |
| `runId`                                     | Stable ID used by inspect, execute, apply, and report    |
| `input`, `resolved`                         | Requested input and resolved base/head object IDs        |
| `consent`                                   | Generation and execution permissions                     |
| `coverage`                                  | `skipped`, `unavailable`, `generated`, or `executed`     |
| `findings`                                  | Optional count, severity totals, and artifact paths      |
| `differential`                              | Optional classification and base/head evidence summary   |
| `status`, `statusReason`                    | `passed`, `partial`, or `failed` plus explanation        |
| `project`, `changedFiles`, `generatedFiles` | Detected project and file effects                        |
| `commands`, `results`                       | Executed commands and exit codes                         |
| `playwrightReport`                          | Native HTML entry path, or `null` when none was produced |
| `patch`, `patchBytes`                       | Generated patch path and size                            |

Handle both returned failure status and rejected stages:

```ts
try {
  const summary = await runPipeline({ repo, workingTree: true, execute: true });

  if (summary.status === "failed") {
    process.exitCode = 1;
  }
} catch (error) {
  // Setup, Codex, integrity, and other required-stage failures reject.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
```

`ChangeForgeError` is not exported from the package root in v0.1, so consumers should currently narrow with the standard `Error` interface. After `executeRun`, call `inspectRun` for the canonical persisted view; its inferred return type is not yet normalized to `RunSummary` in every path.

## Inspection result

`inspectRun({ repo, runId })` returns:

- the validated manifest and phase states
- structured findings and severity counts
- generated paths and planned commands
- capabilities and artifact metadata
- summary and differential evidence when present
- `integrityErrors` for damaged or missing individual artifacts

Inspection never executes project code or invokes Codex.

### Run evidence and cleanup

Readable output is stored under `changeforge/<run-id>/`. A native report produced by either a passing or failing Playwright command is copied to `changeforge/<run-id>/playwright-report/index.html` before the temporary checkout is removed. Machine evidence, logs, checksummed artifacts, and the manifest live under `.changeforge/runs/<run-id>/`.

```ts
import { cleanRuns, pruneRuns } from "changeforge";

await cleanRuns(repo, { dryRun: true });
await cleanRuns(repo, { runId });
await cleanRuns(repo, { keep: 10 });
await pruneRuns(repo); // keeps the newest ten
```

Cleanup removes the paired machine and public run folders, skips active runs, and does not remove a sidecar already applied to the project test tree. `pruneRuns` keeps the newest ten runs.

Retired report-generator and automatic-repair keys in older configuration and v1 manifests are accepted for compatibility, discarded during validation, and never executed.

## Embed the CLI

```ts
import { buildProgram } from "changeforge";

const program = buildProgram();
await program.parseAsync([
  "node",
  "embedded-changeforge",
  "doctor",
  "--repo",
  process.cwd(),
]);
```

Importing the package is side-effect free. Parsing the Commander program intentionally writes CLI output and may set `process.exitCode`. Prefer the workflow functions for application logic.

## Structured findings

Validate strict model JSON and render the canonical Markdown view:

```ts
import { parseFindingsV1, renderFindingsMarkdown } from "changeforge";

const document = parseFindingsV1(modelOutput, repo);
const markdown = renderFindingsMarkdown(document);
```

The parser accepts schema v1, caps output at 1 MiB and 200 findings, normalizes repository-relative locations, and generates stable evidence-based IDs.

## Persisted manifests

```ts
import {
  createRunManifestV1,
  setPhase,
  stageImmutableArtifact,
  validateRunManifestV1,
} from "changeforge";

const manifest = createRunManifestV1({
  runId,
  input: { kind: "commit", value: "HEAD" },
  resolved: { baseSha, headSha, changeSha256 },
  config,
  plan,
  capabilities,
});

const reviewing = setPhase(manifest, "review", "running");
const checked = validateRunManifestV1(reviewing);
const revised = await stageImmutableArtifact(
  repo,
  checked,
  "findings",
  "artifacts/findings.v1.json",
);
```

`stageImmutableArtifact` writes the content-addressed blob and returns a revised manifest. It does not persist that returned manifest for you.

## Change snapshots

Validate and restore a previously captured snapshot:

```ts
import {
  restoreChangeSet,
  snapshotChangeSet,
  validateChangeSnapshotV1,
} from "changeforge";

const snapshot = validateChangeSnapshotV1(rawSnapshot);
const restored = await restoreChangeSet(repo, snapshot);
const normalizedCopy = snapshotChangeSet(restored);
```

The v0.1 root API does not export the resolver used to create a new `ResolvedChangeSet`. Snapshot helpers are therefore best used with ChangeForge-produced snapshot artifacts.

## Generated overlays

```ts
import {
  applyGeneratedOverlay,
  generatedOverlayState,
  replayGeneratedOverlay,
  validateGeneratedOverlayV1,
} from "changeforge";

const overlay = validateGeneratedOverlayV1(rawOverlay);

// Use only in a prepared disposable root.
await replayGeneratedOverlay(tempRoot, overlay);

// Use for a guarded destination with matching preimages.
const state = await generatedOverlayState(repo, overlay);
const applied = await applyGeneratedOverlay(repo, overlay);
```

`captureGeneratedOverlay` is also exported, but its `PatchBaseline` dependency is not yet public at the package root. Use `applyRun` instead of raw overlay functions for normal user checkouts.

## Differential helpers

Classify already validated sides:

```ts
import { buildDifferentialResult, classifyDifferential } from "changeforge";

const classification = classifyDifferential(baseSide, headSide);
const result = buildDifferentialResult(baseSide, headSide);
```

Parse raw Playwright JSON evidence:

```ts
import { parsePlaywrightJsonSide } from "changeforge";

const baseSide = parsePlaywrightJsonSide(
  "base",
  commandResult,
  "logs/base.log",
  { root: baseRoot, path: generatedTestPath },
);
```

Run the low-level verifier only with prepared disposable base and head roots:

```ts
import { runDifferentialVerification } from "changeforge";

const evidence = await runDifferentialVerification({
  baseRoot,
  headRoot,
  evidenceRoot,
  generatedTestPath: "tests/changeforge/change.spec.ts",
  overlay,
  packageManager: "npm",
  timeoutMs: 120000,
});
```

The runner executes Playwright and writes runtime state in both roots. The base root must match the overlay preimage; the head root must already match its postimage.

## Complete export map

| Group               | Runtime exports                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow            | `buildProgram`, `runPipeline`, `inspectRun`, `executeRun`, `applyRun`, `cleanRuns`, `pruneRuns`                                                                         |
| Findings            | `FINDINGS_SCHEMA_VERSION`, `MAX_FINDINGS`, `MAX_REVIEW_OUTPUT_BYTES`, `parseFindingsV1`, `renderFindingsMarkdown`                                                       |
| Manifests           | `RUN_MANIFEST_FILE`, `RUN_MANIFEST_SCHEMA_VERSION`, `RUN_PHASES`, `createRunManifestV1`, `setPhase`, `validateRunManifestV1`, `stageImmutableArtifact`                  |
| Snapshots           | `CHANGE_SNAPSHOT_SCHEMA_VERSION`, `snapshotChangeSet`, `restoreChangeSet`, `validateChangeSnapshotV1`                                                                   |
| Overlays            | `GENERATED_OVERLAY_SCHEMA_VERSION`, `captureGeneratedOverlay`, `replayGeneratedOverlay`, `applyGeneratedOverlay`, `generatedOverlayState`, `validateGeneratedOverlayV1` |
| Differential model  | `DIFFERENTIAL_SCHEMA_VERSION`, `parsePlaywrightJsonSide`, `classifyDifferential`, `buildDifferentialResult`                                                             |
| Differential runner | `DIFFERENTIAL_EXECUTION_SCHEMA_VERSION`, `differentialPlaywrightSpec`, `runDifferentialVerification`, `validateDifferentialArtifactV1`                                  |

Exported types:

- Workflow: `RunOptions`, `RunSummary`, `RunStatus`, `InspectRunOptions`, `ExecuteRunOptions`, `ApplyRunOptions`, `CleanRunsOptions`, `CleanRunsResult`
- Findings: `FindingV1`, `FindingSeverity`, `FindingsDocumentV1`, `FindingsArtifactsV1`
- Manifests: `RunArtifactV1`, `RunCapabilitiesV1`, `RunManifestV1`, `RunPhase`, `RunPhaseState`, `RunPlanV1`
- Snapshots and overlays: `ChangeSnapshotV1`, `GeneratedOverlayV1`
- Differential: `DifferentialClassification`, `DifferentialCommandResult`, `DifferentialOutcome`, `DifferentialResultV1`, `DifferentialSideV1`, `DifferentialExecutionV1`, `DifferentialRunnerOptions`, `DifferentialArtifactV1`

Several advanced functions currently depend on types or constructors that are not re-exported. Treat the workflow API as the supported integration surface until those boundaries are finalized.

## Trust model

Library calls have the same boundaries as the CLI:

- review context is sent through Codex
- execution, installs, and web servers are host processes
- temporary filesystems are checkout-isolated, not hermetic
- evidence directories are written under the source repository

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the full boundary model.
