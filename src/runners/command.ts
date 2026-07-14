import { execa } from "execa";
import path from "node:path";
import type { Writable } from "node:stream";
import { writeTextContained } from "../utils/fs.js";
import type { CommandResult, CommandSpec } from "../core/types.js";

export type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  check?: boolean;
  logFile?: string;
  logRoot?: string;
  stream?: boolean;
  stdout?: Writable;
  stderr?: Writable;
  timeoutMs?: number;
  cancelSignal?: AbortSignal;
  extendEnv?: boolean;
  maxBuffer?: number;
  shell?: boolean;
};

export async function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const started = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const child = execa(command, args, {
    cwd,
    env: options.env,
    input: options.input,
    timeout: options.timeoutMs,
    cancelSignal: options.cancelSignal,
    forceKillAfterDelay: 1000,
    extendEnv: options.extendEnv,
    maxBuffer: options.maxBuffer,
    reject: false,
    shell: options.shell
  });
  if (options.stream) {
    child.stdout?.pipe(options.stdout ?? process.stdout, { end: false });
    child.stderr?.pipe(options.stderr ?? process.stderr, { end: false });
  }
  const result = await child;
  const errorCode = "code" in result && typeof result.code === "string" ? result.code : null;
  const exitCodeKnown = typeof result.exitCode === "number" && Number.isInteger(result.exitCode);
  const failed = result.failed || !exitCodeKnown || Boolean(result.signal) || result.timedOut || result.isCanceled;
  const exitCode = failed && (!result.exitCode || result.exitCode === 0)
    ? (result.timedOut ? 124 : 1)
    : (result.exitCode ?? 0);
  const out: CommandResult = {
    command,
    args,
    cwd,
    exitCode,
    exitCodeKnown,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
    timedOut: result.timedOut,
    signal: result.signal ?? null,
    errorCode,
    failed,
    isCanceled: result.isCanceled
  };
  if (options.logFile) {
    await writeTextContained(options.logRoot ?? cwd, options.logFile, `$ ${[command, ...args].join(" ")}\n\n${out.stdout}\n${out.stderr}`);
  }
  if (options.check !== false && out.failed) {
    throw new Error(`Command failed (${out.exitCode}): ${[command, ...args].join(" ")}\n${out.stderr || out.stdout}`);
  }
  return out;
}

export async function commandOk(command: string, args: string[] = ["--version"], cwd = process.cwd(), timeoutMs = 10000) {
  const result = await runCommand(command, args, { cwd, check: false, timeoutMs });
  return !result.failed;
}

export function commandSpec(command: string, args: string[] = []): CommandSpec {
  return { command, args, display: [command, ...args].map(displayArg).join(" ") };
}

export function runSpec(command: CommandSpec, options: RunCommandOptions = {}) {
  return runCommand(command.command, command.args, options);
}

export async function runShell(command: string, options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logFile?: string;
  logRoot?: string;
  stream?: boolean;
  extendEnv?: boolean;
  timeoutMs?: number;
  cancelSignal?: AbortSignal;
}) {
  const logFile = options.logFile ? path.resolve(options.logFile) : undefined;
  return runCommand(command, [], {
    cwd: options.cwd,
    env: options.env,
    extendEnv: options.extendEnv,
    check: false,
    logFile,
    logRoot: options.logRoot,
    stream: options.stream,
    timeoutMs: options.timeoutMs,
    cancelSignal: options.cancelSignal,
    shell: true
  });
}

function displayArg(value: string) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}
