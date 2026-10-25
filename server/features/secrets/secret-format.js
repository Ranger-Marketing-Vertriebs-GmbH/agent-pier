import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SECRET_HEADER =
  "# Managed by AgentPier. Do not edit; changes are overwritten.";

/**
 * An agent's delivered file below assistants/ (agent-secrets.js), or a temporary of
 * it (writeSecretFile); never backed up.
 */
export const agentSecretMember =
  /^workspaces\/[^/]+\/\.agentpier\/secrets\.env(\.\d+\.[0-9a-f]+\.tmp)?$/;

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
 * True when `file` is a regular file (never followed through a link) holding `text`;
 * its mode is then set to 0600. A link, a folder or other content is replaced.
 */
async function unchangedFile(file, text) {
  let handle;
  try {
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (["ENOENT", "ELOOP", "EISDIR", "EMLINK"].includes(error.code)) return false;
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) return false;
    if ((await handle.readFile("utf8")) !== text) return false;
    await handle.chmod(0o600);
    return true;
  } finally {
    await handle.close();
  }
}

/** True for an existing real folder; a link or another file type is refused. */
async function existingFolder(folder) {
  let info;
  try {
    info = await fs.promises.lstat(folder);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw Object.assign(new Error("Unsafe secret folder."), {
      code: "SECRET_UNSAFE_PATH",
    });
  return true;
}

/**
 * Writes the entries to `file` (0600, atomic) or removes it when there are none.
 * Resolves "written", "removed" or "unchanged" (identical content, or nothing to remove).
 * With `create: false` a missing folder is never created: the write resolves
 * "unchanged", also when the folder disappears while it runs.
 */
export async function writeSecretFile(file, entries, { create = true } = {}) {
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
  if (create) await privateFolder(path.dirname(file));
  else if (!(await existingFolder(path.dirname(file)))) return "unchanged";
  if (await unchangedFile(file, text)) return "unchanged";
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(tmp, text, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await unlinkQuietly(tmp).catch(() => {});
    if (!create && error.code === "ENOENT") return "unchanged";
    throw error;
  }
  return "written";
}
