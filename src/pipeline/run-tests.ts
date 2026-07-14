import path from "node:path";
import { ChangeForgeError } from "../core/errors.js";
import type { ChangeForgeConfig, CommandResult, CommandSpec, ProjectDetection, RunContext } from "../core/types.js";
import { playwrightCommandSpec, unitCommandSpec } from "../project/test-commands.js";
import { runShell, runSpec } from "../runners/command.js";
import { runPlaywright } from "../runners/playwright.js";
import { ensureDirContained, removeContained, writeTextContained } from "../utils/fs.js";

export type TestOptions = {
  execute?: boolean;
  unit?: boolean;
  playwright?: boolean;
  unitCommand?: string;
  playwrightCommand?: string;
  generatedPlaywright?: boolean;
};

type CommandSelection = { display: string; spec?: CommandSpec; shell?: string };
export type TestResult = { name: string; command: string; result: CommandResult };

export async function runTests(context: RunContext, project: ProjectDetection, config: ChangeForgeConfig, options: TestOptions) {
  const results: TestResult[] = [];
  if (!options.execute) return results;
  if (options.unit !== false) {
    const selection = selectUnitCommand(project, config, options);
    if (selection) results.push({
      name: "unit",
      command: selection.display,
      result: await runSelection(selection, context, "unit.log", config.commandTimeoutMs)
    });
  }
  const custom = options.playwrightCommand ?? config.playwrightCommand;
  if (options.playwright === false || !config.playwright.enabled || (!project.hasPlaywright && !custom)) return results;
  const selection = selectPlaywrightCommand(context, project, config, options);
  if (!selection) return results;
  if (usesGeneratedPlaywrightConfig(context, project, config, options)) {
    await writeGeneratedPlaywrightConfig(context, config);
  }
  const reportDir = runtimePlaywrightReportDir(context);
  await removeContained(context.workRoot, reportDir);
  await ensureDirContained(context.workRoot, path.dirname(reportDir));
  const logFile = path.join(context.runDir, "logs/playwright.log");
  const env = playwrightEnv(context, options);
  const result = selection.spec
    ? await runPlaywright(context.workRoot, selection.spec, logFile, context.originalRoot, config.commandTimeoutMs, env)
    : await runShell(selection.shell!, {
      cwd: context.workRoot,
      env,
      extendEnv: false,
      logFile,
      logRoot: context.originalRoot,
      stream: true,
      timeoutMs: config.commandTimeoutMs
    });
  results.push({ name: "playwright", command: selection.display, result });
  return results;
}

export function selectPlaywrightCommand(
  context: RunContext,
  project: ProjectDetection,
  config: ChangeForgeConfig,
  options: TestOptions
): CommandSelection | null {
  const custom = options.playwrightCommand ?? config.playwrightCommand;
  if (custom) return shell(generatedCommand(custom, Boolean(options.generatedPlaywright)));
  if (!project.packageManager) return null;
  const args = !options.generatedPlaywright && context.e2eTestFileExists && context.e2eTestFile
    ? [context.e2eTestFile]
    : [context.generatedTestFile];
  const generatedConfig = usesGeneratedPlaywrightConfig(context, project, config, options);
  if (options.generatedPlaywright && project.playwrightConfig) {
    args.push("--config", path.join(context.workRoot, project.playwrightConfig));
  } else if (generatedConfig) {
    args.push("--config", generatedPlaywrightConfigPath(context));
  }
  if (options.generatedPlaywright || generatedConfig) args.push("--workers=1");
  args.push("--reporter=html");
  return direct(playwrightCommandSpec(project.packageManager, args));
}

function selectUnitCommand(project: ProjectDetection, config: ChangeForgeConfig, options: TestOptions) {
  const custom = options.unitCommand ?? config.unitCommand;
  if (custom) return shell(custom);
  if (!project.packageManager) return null;
  const command = unitCommandSpec(project.packageManager, project.scripts);
  return command ? direct(command) : null;
}

async function runSelection(selection: CommandSelection, context: RunContext, logName: string, timeoutMs: number) {
  const options = {
    cwd: context.workRoot,
    logFile: path.join(context.runDir, `logs/${logName}`),
    logRoot: context.originalRoot,
    stream: true,
    timeoutMs
  } as const;
  return selection.spec ? runSpec(selection.spec, { ...options, check: false }) : runShell(selection.shell!, options);
}

function usesGeneratedPlaywrightConfig(
  context: RunContext,
  project: ProjectDetection,
  config: ChangeForgeConfig,
  options: TestOptions
) {
  return !options.playwrightCommand && !config.playwrightCommand && !project.playwrightConfig
    && (Boolean(options.generatedPlaywright) || !context.e2eTestFileExists);
}

function generatedPlaywrightConfigPath(context: RunContext) {
  return path.join(context.workRoot, ".changeforge-runtime/playwright.config.ts");
}

async function writeGeneratedPlaywrightConfig(
  context: RunContext,
  config: ChangeForgeConfig
) {
  await writeTextContained(
    context.workRoot,
    generatedPlaywrightConfigPath(context),
    buildGeneratedPlaywrightConfig(context, config)
  );
}

export function buildGeneratedPlaywrightConfig(
  context: RunContext,
  config: ChangeForgeConfig
) {
  const webServer = config.webServer.command && config.webServer.url
    ? `  webServer: { command: ${JSON.stringify(config.webServer.command)}, url: ${JSON.stringify(config.webServer.url)}, cwd: ${JSON.stringify(context.workRoot)}, timeout: ${config.webServer.timeoutMs}, reuseExistingServer: false },\n`
    : "";
  const use = config.webServer.url
    ? `{ trace: "on-first-retry", baseURL: ${JSON.stringify(config.webServer.url)} }`
    : `{ trace: "on-first-retry" }`;
  return `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ${JSON.stringify(path.dirname(context.generatedTestFile))},
  timeout: 30000,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [["html", { outputFolder: ${JSON.stringify(runtimePlaywrightReportDir(context))}, open: "never" }]],
${webServer}  use: ${use}
});
`;
}

export function runtimePlaywrightReportDir(context: RunContext) {
  return path.join(context.workRoot, ".changeforge-runtime/playwright-report");
}

function direct(spec: CommandSpec): CommandSelection {
  return { display: spec.display, spec };
}

function shell(command: string): CommandSelection {
  return { display: command, shell: command };
}

function playwrightEnv(context: RunContext, options: TestOptions) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    PLAYWRIGHT_HTML_OUTPUT_DIR: runtimePlaywrightReportDir(context)
  };
  delete env.NO_COLOR;
  if (options.generatedPlaywright) env.CHANGEFORGE_TEST_FILE = context.generatedTestFile;
  return env;
}

function generatedCommand(command: string, generated: boolean) {
  if (!generated) return command;
  if (!command.includes("{testFile}")) {
    throw new ChangeForgeError(
      "A custom Playwright command for generated coverage must include {testFile}.",
      "PLAYWRIGHT_COMMAND_TARGET_REQUIRED"
    );
  }
  const token = process.platform === "win32" ? '"%CHANGEFORGE_TEST_FILE%"' : '"$CHANGEFORGE_TEST_FILE"';
  return command.replaceAll("{testFile}", token);
}
