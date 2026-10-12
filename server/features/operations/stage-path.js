import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { problem } from "../../lib/storage.js";
import { relativeName } from "./files.js";

const outside = () => problem(serverMessages.backups.invalidMemberPath);

/**
 * The absolute path for archive member `name` inside restore stage `stage`, the
 * one check every restore write goes through: `name` is a clean relative path, the
 * result lies inside the stage's real path, and no existing component on the way
 * is a link or a file. Extraction never creates links, so what this accepts stays
 * inside the stage when the file is then created.
 */
export function stagePath(stage, name) {
  try {
    relativeName(name);
  } catch {
    throw outside();
  }
  const root = fs.realpathSync(stage);
  const target = path.resolve(root, name);
  if (!target.startsWith(root + path.sep)) throw outside();
  let cursor = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep)) {
    if (!part) continue;
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw outside();
  }
  const last = fs.lstatSync(target, { throwIfNoEntry: false });
  if (last?.isSymbolicLink()) throw outside();
  return target;
}
