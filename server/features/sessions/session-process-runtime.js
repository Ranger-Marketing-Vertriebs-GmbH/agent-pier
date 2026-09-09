import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
export const safeEnvironment = () =>
  Object.fromEntries(
    ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );

export function execute(command, args, { input, env = safeEnvironment() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
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
