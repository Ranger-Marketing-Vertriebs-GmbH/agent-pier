import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../../lib/launch-serialization.js";
import { validSession } from "./request-validation.js";

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

async function ownedDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
    throw Error("Unsafe Claude request plugin directory");
}

export async function writeClaudeHooks(directory, id) {
  const plugin = path.join(directory, `${id}.claude`);
  await ownedDirectory(plugin);
  await ownedDirectory(path.join(plugin, "hooks"));
  const hook = {
    type: "command",
    // Claude caches this command. The private dispatcher changes atomically
    // with the server, so an existing session does not pin an obsolete release.
    command: ["/bin/sh", path.join(directory, "claude-hook.sh")]
      .map(shellQuote)
      .join(" "),
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

/** Called only after the broker has checked exclusive ownership of its socket. */
export async function refreshClaudeRuntime(directory) {
  const command = [
    process.execPath,
    fileURLToPath(new URL("./claude-hook.js", import.meta.url)),
  ]
    .map(shellQuote)
    .join(" ");
  await atomic(
    path.join(directory, "claude-hook.sh"),
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
      await writeClaudeHooks(directory, id);
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
}
