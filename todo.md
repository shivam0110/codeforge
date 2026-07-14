# ChangeForge Roadmap

## Direction

Build ChangeForge as a **change verification engine**:

> Resolve a change once, review it without mutating the checkout, generate relevant validation, prove the validation distinguishes base from head, and publish an auditable evidence bundle.

Playwright is the first validator, not the product boundary.

## Current Baseline

- [x] Immutable Git change resolution and external sandbox materialization
- [x] Read-only review by default
- [x] Separate `--generate`, `--execute`, and dependency-install consent
- [x] Strict configuration, path containment, symlink-safe I/O, and non-mutating patch creation
- [x] Restricted Playwright generation with placeholder rejection
- [x] Single-attempt generation and execution with no automatic test repair
- [x] Native Playwright HTML reports preserved for passing and failing runs
- [x] Typed library entrypoint, packaged CLI tests, and cross-platform CI matrix
- [x] Fast local dependency reuse, trusted setup commands, and paired run retention/cleanup

## Phase 1 — Compelling Local Verification Engine

### P0: Close Remaining Trust and Correctness Gaps

- [x] Detect a missing parent in shallow clones and return `GIT_HISTORY_SHALLOW` with fetch guidance instead of treating the commit as a root commit
- [x] Generate only a new strict sidecar and reject process, environment, filesystem, outbound network, and runtime-module recovery APIs
- [x] Label current command execution as `checkout-isolated`; reserve `hermetic` or `sandboxed` for a future container executor
- [ ] Wire `AbortSignal` through `runPipeline` and clean temporary sandboxes on `SIGINT` and `SIGTERM`

### P1: Structured Findings

- [x] Add a versioned `findings.v1.json` artifact
- [x] Give each finding a stable ID, severity, confidence, file, line, title, evidence, and suggested validation
- [x] Validate Codex output before publishing it
- [ ] Add `--format markdown|json|sarif`
- [ ] Add `--fail-on low|medium|high|critical` and `--fail-on-partial`

Acceptance criteria:

- Findings can be consumed without parsing Markdown
- Invalid or incomplete model output cannot silently become a successful review
- The same finding retains its ID across repeated runs when its evidence is unchanged

### P1: Differential Test Verification

- [x] Materialize isolated base and head verification views
- [x] Run the exact generated sidecar against both revisions
- [x] Classify evidence as `regression-proof`, `no-discrimination`, `invalid`, or `regression-detected`
- [x] Preserve bounded stdout, stderr, counts, timings, logs, and command metadata for both executions
- [ ] Persist and checksum Playwright trace attachments for both executions
- [x] Prevent a generated test that passes on both base and head from being reported as proof

Acceptance criteria:

- The report can prove whether a generated test distinguishes the change
- A test that only passes on head is not automatically considered valuable
- Base/head verification remains opt-in and bounded by configured timeouts

### P1: Resumable Inspect-Before-Execute Workflow

- [x] Add `changeforge inspect --run <id>` to show findings, generated files, commands, capabilities, phases, and integrity errors
- [x] Add `changeforge execute --run <id>` to execute an already reviewed/generated run without repeating Codex work
- [x] Add `changeforge apply --run <id>` to copy an approved sidecar into the current checkout after source/preimage checks
- [x] Store phase completion and content-addressed artifact checksums in a versioned run manifest
- [x] Keep one-shot `run --generate --execute` as an explicitly trusted convenience

### P1: Unified Evidence Report

- [ ] Create one static `index.html` per run
- [ ] Show resolved change, findings, consent, generated patch, base/head results, commands, timings, and coverage gaps
- [ ] Link Playwright traces and native HTML reports
- [ ] Make `changeforge report` open the unified report instead of the native Playwright entry point
- [ ] Add a concise terminal summary with the same status model

### P1: Context, Privacy, and Cost Controls

- [ ] Add `.changeforgeignore`
- [ ] Detect binary and generated files before prompt construction
- [ ] Add per-file, total-byte, and token budgets
- [ ] Add secret detection and configurable redaction
- [ ] Add `changeforge context --preview` to show exactly what will be sent to Codex
- [ ] Record model, tool versions, prompt/config hashes, timings, and token usage in `run-manifest.v1.json`

## Phase 1 Definition of Done

- [ ] A public example demonstrates a finding and a generated test that fails on base and passes on head
- [x] A complete run can be reviewed before any generated code executes
- [ ] Every final verdict is backed by structured evidence
- [ ] Large or sensitive context is bounded and previewable
- [ ] Unit, integration, package, and adversarial tests pass on Linux, macOS, and Windows

## Phase 2 — GitHub and CI Distribution

### Official GitHub Action

- [ ] Create `changeforge/action` with pinned runtime dependencies
- [ ] Support `range`, `generate`, `execute`, `fail-on`, and artifact-retention inputs
- [ ] Resolve pull-request base/head SHAs correctly, including shallow-checkout recovery
- [ ] Upload the complete evidence bundle as a workflow artifact
- [ ] Publish SARIF to GitHub code scanning
- [ ] Create a GitHub Check with line annotations and a concise PR summary
- [ ] Document headless Codex authentication and least-privilege permissions
- [ ] Provide review-only and trusted-execution workflow examples

### CI Gate Policies

- [ ] Support repository policy files for required validators and severity thresholds
- [ ] Add explicit outcomes for `reviewed`, `verified`, `partial`, `policy-failed`, and `execution-failed`
- [ ] Emit JUnit for command/test results
- [ ] Deduplicate findings across repeated PR runs
- [ ] Add baseline suppression with owner, reason, and expiry

### Pull Request Experience

- [ ] Post one updateable PR comment instead of a new comment per run
- [ ] Show new, resolved, and unchanged findings
- [ ] Attach generated patches without applying them automatically
- [ ] Link directly to the unified report, traces, and failing evidence
- [ ] Add a compact status badge for README and PR checks

## Phase 3 — Scale and Extensibility

- [ ] Cache dependency sandboxes by lockfile, package manager, Node version, and platform
- [ ] Support npm, pnpm, and Yarn workspaces with affected-package detection
- [ ] Add validator adapters for Vitest/Jest, Playwright, TypeScript API compatibility, and custom commands
- [ ] Add optional mutation testing for generated-test qualification
- [ ] Stream or lazily materialize large repositories instead of buffering every blob
- [ ] Add performance budgets for memory, disk amplification, duration, and prompt size
- [ ] Publish a reproducible evaluation corpus and raw-Codex comparison

## Release and Community

- [ ] Add tagged releases and a changelog
- [ ] Publish npm packages with provenance and an SBOM
- [ ] Add `SECURITY.md`, a formal threat model, and vulnerability-reporting instructions
- [ ] Add `CONTRIBUTING.md`, issue templates, and architecture decision records
- [ ] Publish three sample repositories and complete evidence bundles
- [ ] Record a short end-to-end demo

## Not Now

- Additional model providers
- Python, Go, or Java support
- Hosted dashboard, accounts, billing, or telemetry
- Automatic production-source fixes
- Generic chat UI

Do not expand these areas until differential verification, structured findings, and the GitHub workflow have demonstrated repeatable user value.
