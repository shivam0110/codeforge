import path from "node:path";
import { ChangeForgeError } from "../core/errors.js";
import { changedPaths, readManifest, type ManifestEntry } from "../git/patch.js";
import { existsContained } from "../utils/fs.js";

export function createInputIntegrityGuard(root: string, ignored: () => string[] = () => []) {
  let frozen: Map<string, ManifestEntry> | null = null;
  let generatedOutputRoots: string[] | null = null;
  const readInputs = async () => {
    generatedOutputRoots ??= await runOwnedOutputRoots(root);
    return readManifest(root, null, [...ignored(), ...generatedOutputRoots]);
  };
  return {
    outputRoots() {
      return [...(generatedOutputRoots ?? [])];
    },
    async refresh() {
      frozen = await readInputs();
    },
    async verify() {
      if (!frozen) throw new ChangeForgeError("Verification inputs were not frozen.", "VERIFICATION_INPUT_MISSING");
      const changed = verificationInputChanges(frozen, await readInputs());
      if (changed.length) {
        throw new ChangeForgeError(
          `Project inputs changed during verification: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", …" : ""}`,
          "VERIFICATION_INPUT_MUTATED"
        );
      }
    }
  };
}

const ownedOutputRoots = new Set([
  ".cache", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vite",
  "build", "coverage", "dist", "out", "playwright-report", "test-results"
]);

export function isRunOwnedOutputRoot(value: string) {
  return ownedOutputRoots.has(value);
}

export async function runOwnedOutputRoots(root: string) {
  const presence = await Promise.all([...ownedOutputRoots].map((outputRoot) =>
    existsContained(root, path.join(root, outputRoot))
  ));
  return [...ownedOutputRoots].filter((_, index) => !presence[index]);
}

export function verificationInputChanges(
  before: Map<string, ManifestEntry>,
  after: Map<string, ManifestEntry>
) {
  return changedPaths(before, after);
}
