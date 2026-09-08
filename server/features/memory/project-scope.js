import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { failure } from "./memory-validation.js";
const execute = promisify(execFile);
export async function projectScope(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd))
    throw failure("Invalid memory project directory.");
  let canonical;
  try {
    canonical = fs.realpathSync(cwd);
    if (!fs.statSync(canonical).isDirectory()) throw Error();
  } catch {
    throw failure("Memory project directory is unavailable.", 404);
  }
  let common = canonical,
    kind = "directory",
    root = canonical;
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: canonical,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const result = await execute(
      "git",
      [
        "-C",
        canonical,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      { env, timeout: 3000, maxBuffer: 16384, encoding: "utf8" },
    );
    const values = result.stdout.trimEnd().split("\n");
    if (values.length !== 2 || values.some((value) => !path.isAbsolute(value)))
      throw failure("Cannot identify the Git memory project.", 409);
    common = fs.realpathSync(values[0]);
    root = fs.realpathSync(values[1]);
    kind = "git";
  } catch (error) {
    if (error.status) throw error;
    if (error.killed || error.code === "ETIMEDOUT")
      throw failure("Git project discovery timed out.", 409);
    if (error.code !== "ENOENT" && !/not a git repository/i.test(error.stderr || ""))
      throw failure("Cannot identify the Git memory project.", 409);
  }
  const stat = fs.statSync(common, { bigint: true });
  const identity = JSON.stringify([kind, common, String(stat.dev), String(stat.ino)]);
  return {
    id: createHash("sha256").update(identity).digest("hex"),
    name: path.basename(root),
    cwd: root,
    kind,
    identity,
  };
}
