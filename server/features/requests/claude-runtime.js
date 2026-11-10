import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { shellQuote } from "../../lib/launch-serialization.js";
import { validSession } from "./request-validation.js";
import { hookScript } from "./claude-hook-handover.js";

export const claudeHookVersion = 2;
export const claudeHookTimeoutSeconds = 24 * 60 * 60;

async function atomic(file, content, mode = 0o600) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** The dispatcher every Claude hook command names (`/bin/sh <folder>/claude-hook.sh`). */
export const dispatcherName = "claude-hook.sh";
/** Where the launches of this release find the dispatcher. */
export const claudeDispatcher = (runtimeDirectory) =>
  path.join(runtimeDirectory, dispatcherName);

async function ownedDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
    throw Error("Unsafe Claude request plugin directory");
}

/**
 * Writes the request hooks of one launch. `dispatcher` is the script they run: the
 * one in the runtime folder, which a session may only read, or for a launch from
 * before that folder existed the one in the request folder itself.
 */
export async function writeClaudeHooks(
  directory,
  id,
  dispatcher = path.join(directory, dispatcherName),
) {
  const plugin = path.join(directory, `${id}.claude`);
  await ownedDirectory(plugin);
  await ownedDirectory(path.join(plugin, "hooks"));
  const hook = {
    type: "command",
    // Claude caches this command. The private dispatcher changes atomically
    // with the server, so an existing session does not pin an obsolete release.
    command: ["/bin/sh", dispatcher].map(shellQuote).join(" "),
    timeout: claudeHookTimeoutSeconds,
  };
  await atomic(
    path.join(plugin, "hooks/hooks.json"),
    JSON.stringify({
      hooks: {
        PermissionRequest: [{ hooks: [hook] }],
        PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook] }],
      },
    }),
  );
}

/**
 * Called only after the broker has checked exclusive ownership of its socket.
 * Writes the dispatcher twice: into `runtimeDirectory`, which sandboxed sessions are
 * granted read-only and every launch of this release names, and into the request
 * folder, where the hook commands of sessions started before still look for it.
 */
export async function refreshClaudeRuntime(directory, runtimeDirectory = directory) {
  const command = [process.execPath, hookScript].map(shellQuote).join(" ");
  const current = claudeDispatcher(runtimeDirectory);
  for (const folder of new Set([runtimeDirectory, directory]))
    await atomic(
      path.join(folder, dispatcherName),
      `#!/bin/sh\nexec ${command} "$@"\n`,
      0o700,
    );
  const reloadRequired = new Set();
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith(".launch.json")) continue;
    const id = name.slice(0, -".launch.json".length);
    if (!validSession(id)) continue;
    const file = path.join(directory, name);
    const info = await fs.lstat(file);
    if (!info.isFile()) continue;
    let launch;
    try {
      launch = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError || error.code === "ENOENT") continue;
      throw error;
    }
    if (launch.id !== id || launch.tool !== "claude") continue;
    if (
      launch.claudeHookVersion === claudeHookVersion &&
      !launch.claudeHookReloadRequired
    )
      continue;
    try {
      // A launch keeps the dispatcher it was started with: an older sandboxed
      // session holds no grant for the runtime folder.
      await writeClaudeHooks(
        directory,
        id,
        launch.claudeHookDispatcher === current ? current : undefined,
      );
    } catch (error) {
      // An interrupted launch can leave its record before creating the plugin.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await atomic(
      file,
      JSON.stringify({ ...launch, claudeHookVersion, claudeHookReloadRequired: true }),
    );
    reloadRequired.add(id);
  }
  return reloadRequired;
}

export async function confirmClaudeRuntime(broker, owner, version) {
  if (
    owner.tool !== "claude" ||
    version !== claudeHookVersion ||
    !broker.claudeReloadRequired.has(owner.id)
  )
    return;
  const file = broker.file(owner.id);
  const launch = JSON.parse(await fs.readFile(file, "utf8"));
  if (launch.token !== owner.token) return;
  delete launch.claudeHookReloadRequired;
  await atomic(file, JSON.stringify(launch));
  broker.claudeReloadRequired.delete(owner.id);
  broker.changed?.(owner.id);
}
