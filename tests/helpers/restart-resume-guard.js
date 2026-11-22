import fs from "node:fs";
import path from "node:path";

/**
 * After a start, OpenClaw sends every session that was working when the Gateway shut
 * down a resume input and replays the messages queued behind it
 * (`resumeMarkedSessions`, src/gateway/session-restart-resume.ts). AgentPier never
 * replays interrupted work, so its `no-restart-resume` patches (runtime-bundle-
 * patches.js) make that pass adopt no marker and keep no queued message. This guard
 * reads the installed package itself, independent of the patch list, so a pin bump
 * that would silently drop the patches fails until they are carried forward.
 */
const definition = /\basync function resumeMarkedSessions\s*\(/;
// The marker adoption (`resumeAfterRestart ?? (… mainRestartRecovery …)`) and the
// queued messages a marker keeps from the orphan withdrawal.
const adoption = /\.resumeAfterRestart \?\? \(/g;
const reserved = /\.resumeAfterRestart\?\.queuedInputIds/g;

function* scripts(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* scripts(file);
    else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) yield file;
  }
}

/**
 * Every script in the package's `dist` that defines `resumeMarkedSessions`, as
 * `{ file, adopts, reserves }` with `file` relative to `packageDir`, `adopts` the
 * number of marker adoptions and `reserves` the number of queued message
 * reservations left in it.
 */
export function restartResumeSites(packageDir) {
  const found = [];
  for (const file of scripts(path.join(packageDir, "dist"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!definition.test(text)) continue;
    found.push({
      file: path.relative(packageDir, file).split(path.sep).join("/"),
      adopts: text.match(adoption)?.length ?? 0,
      reserves: text.match(reserved)?.length ?? 0,
    });
  }
  return found;
}

/**
 * Throws unless the package's startup resume adopts no restart marker and keeps no
 * queued message for a replay. Finding no `resumeMarkedSessions` fails too: upstream
 * may have renamed or moved the resume, and the guard must then be updated rather
 * than pass silently.
 */
export function assertNoRestartResume(packageDir) {
  const found = restartResumeSites(packageDir);
  if (!found.length)
    throw Error(
      `No resumeMarkedSessions found in ${packageDir}/dist; update the restart resume guard.`,
    );
  const resuming = found.filter((site) => site.adopts || site.reserves);
  if (resuming.length)
    throw Error(
      `OpenClaw resumes interrupted turns after a restart: ${resuming
        .map((site) => site.file)
        .join(
          ", ",
        )}. Carry the no-restart-resume patches forward (runtime-bundle-patches.js).`,
    );
  return found;
}
