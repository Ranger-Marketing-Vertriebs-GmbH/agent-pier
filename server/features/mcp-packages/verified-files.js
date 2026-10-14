import fs from "node:fs";
import { createHash } from "node:crypto";
import { packageProblem } from "./package-errors.js";
export { privateFolder } from "../assistants/runtime-paths.js";

export const sha256Matches = (bytes, expected) =>
  createHash("sha256").update(bytes).digest("hex") === expected;

/** A regular file that no link or second name can redirect. */
export function regularFile(file, code = "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE") {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw packageProblem(code, 503);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw packageProblem(code, 503);
  return file;
}
