import path from "node:path";
import { defaultConfig } from "../core/config.js";
import { ChangeForgeError } from "../core/errors.js";
import { repoRoot } from "../git/repo.js";
import { appendUniqueContained, existsContained, writeJsonContained } from "../utils/fs.js";

export async function initCommand(options: { repo?: string; force?: boolean }) {
  const root = await repoRoot(options.repo ?? process.cwd());
  const configFile = path.join(root, ".changeforge/config.json");
  if (!options.force && await existsContained(root, configFile)) {
    throw new ChangeForgeError("ChangeForge config already exists.", "CONFIG_EXISTS", "Use changeforge init --force to replace it.");
  }
  await writeJsonContained(root, configFile, defaultConfig);
  await appendUniqueContained(root, path.join(root, ".gitignore"), [
    ".changeforge/runs/",
    ".changeforge/locks/",
    "changeforge/*/",
  ]);
  console.log(`Initialized ChangeForge in ${path.join(root, ".changeforge")}`);
}
