import fs from "node:fs";
import path from "node:path";

/**
 * OpenClaw's main-session restart recovery resumes a turn a Gateway restart
 * interrupted by asking the model again (`resumeMainSession`). AgentPier never
 * replays interrupted work, so its `no-restart-resume` patch (runtime-bundle-
 * patches.js) replaces the one call with upstream's settlement of the turn. This
 * guard reads the installed package itself, independent of the patch list, so a pin
 * bump that would silently drop the patch fails until it is carried forward.
 */
const definition = /\basync function resumeMainSession\s*\(/;
const call = /\bresumeMainSession\s*\(/g;

function* scripts(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* scripts(file);
    else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) yield file;
  }
}

/**
 * Every script in the package's `dist` that defines or calls `resumeMainSession`,
 * as `{ file, defines, calls }` with `file` relative to `packageDir` and `calls`
 * the number of calls besides the definition.
 */
export function restartResumeSites(packageDir) {
  const found = [];
  for (const file of scripts(path.join(packageDir, "dist"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("resumeMainSession")) continue;
    const defines = definition.test(text);
    found.push({
      file: path.relative(packageDir, file).split(path.sep).join("/"),
      defines,
      calls: (text.match(call)?.length ?? 0) - (defines ? 1 : 0),
    });
  }
  return found;
}

/**
 * Throws unless the package defines `resumeMainSession` and never calls it, and
 * settles the interrupted turn in its place. Finding no definition fails too:
 * upstream may have renamed or moved the resume, and the guard must then be updated
 * rather than pass silently.
 */
export function assertNoRestartResume(packageDir) {
  const found = restartResumeSites(packageDir);
  const home = found.filter((site) => site.defines);
  if (!home.length)
    throw Error(
      `No resumeMainSession found in ${packageDir}/dist; update the restart resume guard.`,
    );
  const calling = found.filter((site) => site.calls > 0);
  if (calling.length)
    throw Error(
      `OpenClaw resumes interrupted turns after a restart: ${calling
        .map((site) => `${site.file} (${site.calls})`)
        .join(
          ", ",
        )}. Carry the no-restart-resume patch forward (runtime-bundle-patches.js).`,
    );
  for (const site of home) {
    const text = fs.readFileSync(path.join(packageDir, ...site.file.split("/")), "utf8");
    if (!/settleInterruptedRestartRecovery\(\{ \.\.\.resume, reason: /.test(text))
      throw Error(
        `${site.file} no longer settles the interrupted turn in place of its resume; update the no-restart-resume patch.`,
      );
  }
  return found;
}
