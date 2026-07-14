import type { CodexResult, CodexTask, CommandResult } from "../core/types.js";

export interface CodexAdapter {
  assertLoggedIn(): Promise<void>;
  login(options: { deviceAuth?: boolean; status?: boolean }): Promise<CommandResult>;
  runTask(task: CodexTask): Promise<CodexResult>;
}
