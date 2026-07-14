import { CodexCliAdapter } from "../codex/cli-adapter.js";

export async function loginCommand(options: { deviceAuth?: boolean; status?: boolean }) {
  return new CodexCliAdapter().login(options);
}
