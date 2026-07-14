export type ChangeInput =
  | { kind: "range"; value: string }
  | { kind: "commit"; value: string }
  | { kind: "file"; value: string }
  | { kind: "working-tree" };

export type PackageManager = "npm" | "pnpm" | "yarn";
export type SandboxMode = "read-only" | "workspace-write";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type PlaywrightTestFocus = "edge-cases" | "full";

export interface CodexConfig {
  adapter: "cli";
  reasoning: ReasoningEffort;
  stream: boolean;
  ignoreRules: boolean;
  timeoutMs: number;
  reviewSystemPrompt: string | null;
  testGenerationSystemPrompt: string | null;
}

export interface ChangeForgeConfig {
  docsDir: string;
  testsDir: string;
  allowSourceEdits: boolean;
  commandTimeoutMs: number;
  setupCommand: string | null;
  unitCommand: string | null;
  playwrightCommand: string | null;
  webServer: { command: string | null; url: string | null; timeoutMs: number };
  codex: CodexConfig;
  playwright: {
    enabled: boolean;
    preferStableLocators: boolean;
    testFocus: PlaywrightTestFocus;
    e2eTestPath: string | null;
  };
}

export interface ProjectDetection {
  rootDir: string;
  packageManager: PackageManager | null;
  hasPackageJson: boolean;
  hasPlaywright: boolean;
  hasPlaywrightConfig: boolean;
  scripts: Record<string, string>;
  deps: Record<string, string>;
  suggestedUnitCommand: string | null;
  suggestedPlaywrightCommand: string | null;
  missingRecommendedDeps: string[];
  playwrightConfig: string | null;
}

export interface DiffContext {
  input: ChangeInput;
  patch: string;
  stat: string;
  nameStatus: string;
  changedFiles: { status: string; paths: string[] }[];
  gitlinks?: { path: string; oldSha?: string; newSha?: string; dirty?: boolean }[];
}

export interface FileSnapshot {
  path: string;
  status: string;
  exists: boolean;
  content: string;
  kind?: "file" | "deleted" | "missing" | "gitlink" | "symlink";
  truncated?: boolean;
  oldSha?: string;
  newSha?: string;
  url?: string;
  branch?: string;
  initialized?: boolean;
}

export interface RunContext {
  runId: string;
  originalRoot: string;
  workRoot: string;
  runDir: string;
  reportDir: string;
  testsDir: string;
  generatedTestFile: string;
  e2eTestFile: string | null;
  e2eTestFileExists: boolean;
  testFocus: PlaywrightTestFocus;
  input: ChangeInput;
  baseSha: string;
  headSha: string;
  generate: boolean;
  execute: boolean;
  allowSourceEdits: boolean;
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  exitCodeKnown: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
  failed: boolean;
  isCanceled: boolean;
}

export interface CommandSpec {
  command: string;
  args: string[];
  display: string;
}

export interface CodexTask {
  cwd: string;
  artifactRoot: string;
  prompt: string;
  sandbox: SandboxMode;
  outputFile: string;
  model?: string;
  reasoning?: ReasoningEffort;
  stream?: boolean;
  logFile?: string;
  ignoreRules?: boolean;
  json?: boolean;
  timeoutMs?: number;
}

export interface CodexResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputFile: string;
}
