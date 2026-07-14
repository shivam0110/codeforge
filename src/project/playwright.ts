import path from "node:path";
import { existsContained } from "../utils/fs.js";

export const playwrightConfigNames = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mts",
  "playwright.config.mjs",
  "playwright.config.cjs"
];

export async function findPlaywrightConfig(root: string) {
  for (const name of playwrightConfigNames) {
    if (await existsContained(root, path.join(root, name))) return name;
  }
  return null;
}
