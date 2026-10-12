import fs from "node:fs";
import path from "node:path";
import { readFile, relativeName } from "./files.js";
import { componentProblem } from "./backup-components.js";

// Small files are read while the backup is planned: the window in which a writer
// can replace or move them is then a single read. Larger ones (transcripts, images,
// database snapshots) are streamed into the archive.
const INLINE_FILE = 1024 * 1024;
const INLINE_BUDGET = 64 * 1024 * 1024;

/** Plans public archive members from files on disk without holding large ones. */
export class CapturePlan {
  constructor({ inlineBudget = INLINE_BUDGET } = {}) {
    this.left = inlineBudget;
  }
  /**
   * The member `name` for regular file `file`, a problem naming `component`, or
   * null when the file disappeared since it was listed.
   */
  file(name, file, component, stat = fs.lstatSync(file)) {
    const entry = { component };
    if (stat.isSymbolicLink()) throw componentProblem("linked", entry);
    if (!stat.isFile() || stat.nlink !== 1) throw componentProblem("unreadable", entry);
    const member = { path: relativeName(name), component };
    if (stat.size <= INLINE_FILE && stat.size <= this.left) {
      try {
        const bytes = readFile(file, INLINE_FILE);
        this.left -= bytes.length;
        return { ...member, bytes };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        // It grew past the inline size since: stream it instead.
        if (error.status !== 413) throw error;
      }
    }
    return { ...member, file, size: stat.size };
  }
  /** Every file below `root` as members below `prefix`. */
  tree(root, prefix, component, exclude = () => false) {
    const result = [];
    const visit = (relative) => {
      if (exclude(relative)) return;
      const file = path.join(root, relative),
        stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
      else {
        const member = this.file(`${prefix}/${relative}`, file, component, stat);
        if (member) result.push(member);
      }
    };
    if (fs.existsSync(root)) for (const name of fs.readdirSync(root).sort()) visit(name);
    return result;
  }
}
