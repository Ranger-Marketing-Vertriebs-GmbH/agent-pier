import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SECRET_HEADER =
  "# Managed by AgentPier. Do not edit; changes are overwritten.";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** The shell-sourceable file for the entries: `NAME='value'`, sorted by name. */
export function secretEnvFile(entries) {
  if (!entries.length) return "";
  const lines = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, value }) => `${name}=${quote(value)}`);
  return `${SECRET_HEADER}\n${lines.join("\n")}\n`;
}

async function unlinkQuietly(file) {
  try {
    await fs.promises.unlink(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Creates the folder 0700 and refuses it when it is, or sits behind, a symlink. */
async function privateFolder(folder) {
  await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await fs.promises.lstat(folder);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw Object.assign(new Error("Unsafe secret folder."), {
      code: "SECRET_UNSAFE_PATH",
    });
  await fs.promises.chmod(folder, 0o700);
}

/**
 * Writes the entries to `file` (0600, atomic) or removes it when there are none.
 * Resolves "written", "removed" or "unchanged" (identical content, or nothing to remove).
 */
export async function writeSecretFile(file, entries) {
  const text = secretEnvFile(entries);
  if (!text) {
    try {
      if ((await fs.promises.lstat(path.dirname(file))).isSymbolicLink())
        throw Object.assign(new Error("Unsafe secret folder."), {
          code: "SECRET_UNSAFE_PATH",
        });
    } catch (error) {
      if (error.code === "ENOENT") return "unchanged";
      throw error;
    }
    return (await unlinkQuietly(file)) ? "removed" : "unchanged";
  }
  await privateFolder(path.dirname(file));
  try {
    if ((await fs.promises.readFile(file, "utf8")) === text) {
      await fs.promises.chmod(file, 0o600);
      return "unchanged";
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
  }
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(tmp, text, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await unlinkQuietly(tmp).catch(() => {});
    throw error;
  }
  return "written";
}
