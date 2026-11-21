import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { withUtf8Locale } from "../../lib/session-locale.js";
export const safeEnvironment = () =>
  withUtf8Locale(
    Object.fromEntries(
      ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    ),
  );

/**
 * A bare command name resolved once against PATH to its absolute executable, so each
 * spawn skips the failing execve attempts through earlier PATH entries. A name not
 * found, or a path given already, stays as it is.
 */
export function resolveCommand(command, searchPath = process.env.PATH || "") {
  if (typeof command !== "string" || command.includes("/")) return command;
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this PATH entry.
    }
  }
  return command;
}

export function execute(command, args, { input, env = safeEnvironment(), cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.trim() || `Terminal command failed (${code})`)),
    );
    child.stdin.end(input);
  });
}
export async function privateWrite(directory, filename, value) {
  if (
    typeof filename !== "string" ||
    filename !== path.basename(filename) ||
    (filename !== "tmux.conf" &&
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(?:json|launch\.json|screen)$/.test(filename))
  )
    throw new Error("Invalid private session filename");
  if (typeof directory !== "string" || !path.isAbsolute(directory))
    throw new Error("Invalid private session directory");
  const file = path.join(directory, path.basename(filename));
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
