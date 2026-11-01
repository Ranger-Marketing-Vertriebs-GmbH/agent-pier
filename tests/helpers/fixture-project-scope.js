import fs from "node:fs";
import path from "node:path";
import {
  directoryScope,
  projectScope,
} from "../../server/features/memory/project-scope.js";

/**
 * projectScope for test fixtures: a folder with no `.git` entry in itself or any
 * parent is a plain folder and gets its scope without spawning Git, so a fixture
 * never depends on Git answering within projectScope's time limit under a loaded
 * test run. Every other folder (a Git work tree, or a path that does not resolve)
 * goes through the real projectScope. Like a spawned Git, it answers in a later
 * event-loop turn: concurrent callers (duplicate MCP starts) resume one at a time.
 */
export async function fixtureProjectScope(cwd, options) {
  await new Promise((resolve) => setImmediate(resolve));
  let dir;
  try {
    dir = fs.realpathSync(cwd);
  } catch {
    return projectScope(cwd, options);
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return projectScope(cwd, options);
    const parent = path.dirname(dir);
    if (parent === dir) return directoryScope(cwd, options);
    dir = parent;
  }
}
