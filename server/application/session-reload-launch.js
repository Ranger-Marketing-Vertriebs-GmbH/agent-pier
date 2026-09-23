import { serverMessages } from "../lib/i18n/de.js";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { problem } from "../lib/storage.js";
import { providerId } from "../features/chat/provider-history.js";

export function resumeLaunch(tool, launch, nativeId) {
  providerId(nativeId);
  const args = [...launch.args];
  if (
    args.some((arg) =>
      [
        "--session-id",
        "--resume",
        "resume",
        "--session",
        "--continue",
        "--last",
      ].includes(arg),
    )
  )
    throw problem(serverMessages.sessionReload.conflictingNativeSelection, 409);
  if (tool === "codex") args.push("resume", nativeId);
  else if (tool === "claude") args.push("--resume", nativeId);
  else if (tool === "opencode") args.push("--session", nativeId);
  else throw problem(serverMessages.sessionReload.notReloadable, 409);
  return { ...launch, args };
}
export async function validateReloadLaunch(launch, cwd) {
  if (!path.isAbsolute(launch.command) || !(await stat(launch.command)).isFile())
    throw problem(serverMessages.sessionReload.cliUnavailable, 409);
  await access(launch.command, constants.X_OK);
  if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw problem(serverMessages.sessionReload.projectDirectoryUnavailable, 409);
}
