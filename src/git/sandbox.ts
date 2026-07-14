import { makeSecureTemp, removeSecureTemp } from "../utils/temp.js";

const prefix = "changeforge-sandbox-";

export function sandboxPath(originalRoot: string) {
  return makeSecureTemp(prefix, [originalRoot]);
}

export function removeSandbox(dir: string) {
  return removeSecureTemp(dir, prefix);
}
