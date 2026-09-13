import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

/** @typedef {{kind:"global"|"project", id:string, root:string,
 * home:string, sessionId:string|null, readOnly:boolean}} FileScope */

async function directory(input) {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0"))
    throw fileProblem("FILE_INVALID_SCOPE", 400);
  const canonical = await fs.realpath(input);
  if (!(await fs.stat(canonical, { bigint: true })).isDirectory())
    throw fileProblem("FILE_NOT_DIRECTORY", 400);
  return canonical;
}

// Only call with host configuration and a server-owned session, never request fields.
export async function makeFileScope({ home, session = null }) {
  try {
    home = await directory(home);
    let root = path.parse(home).root;
    if (session !== null) {
      if (typeof session.id !== "string" || !session.id)
        throw fileProblem("FILE_INVALID_SCOPE", 400);
      const cwd = session.cwd;
      if (typeof cwd !== "string") throw fileProblem("FILE_INVALID_SCOPE", 400);
      root = await directory(
        cwd === "~" ? home : cwd?.startsWith("~/") ? `${home}/${cwd.slice(2)}` : cwd,
      );
    }
    const kind = session === null ? "global" : "project";
    const sessionId = session?.id ?? null;
    const readOnly = session?.pipeline?.headless === true;
    const id = `f1:${createHash("sha256")
      .update(JSON.stringify([kind, sessionId, root, home, readOnly]))
      .digest("hex")}`;
    return Object.freeze({ kind, id, root, home, sessionId, readOnly });
  } catch (error) {
    throw fileSystemProblem(error);
  }
}
