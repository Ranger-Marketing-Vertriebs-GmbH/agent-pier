// The CA bundle files a launch names to its CLI, for the sandbox grants of the
// drivers (`<id>/sandbox.js`).
import fs from "node:fs";
import path from "node:path";

/** `value` when it names a regular file by an absolute path, else null. */
export function bundleFile(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    return fs.statSync(value).isFile() ? value : null;
  } catch {
    return null;
  }
}

/** Read grants for the files the variables `names` of `env` name, each once. */
export function bundleGrants(env = {}, names) {
  const files = names.map((name) => bundleFile(env[name])).filter(Boolean);
  return [...new Set(files)].map((file) => ({ access: "read", path: file }));
}
