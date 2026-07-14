import { ChangeForgeError } from "../core/errors.js";
import type { ChangeInput } from "../core/types.js";

type InputOptions = { range?: string; commit?: string; file?: string; workingTree?: boolean };

export function inputFromOptions(options: InputOptions): ChangeInput {
  const values = [options.range, options.commit, options.file, options.workingTree].filter(Boolean);
  if (values.length > 1) throw new ChangeForgeError("Choose only one change input.", "MULTIPLE_CHANGE_INPUTS");
  if (options.range) return { kind: "range", value: options.range };
  if (options.commit) return { kind: "commit", value: options.commit };
  if (options.file) return { kind: "file", value: options.file };
  if (options.workingTree) return { kind: "working-tree" };
  throw new ChangeForgeError("No change input provided.", "NO_CHANGE_INPUT", "Use --range, --commit, --file, or --working-tree.");
}
