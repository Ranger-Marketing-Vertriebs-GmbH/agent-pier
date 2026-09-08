import { filesCopy } from "./i18n/de/files.js";
import { serverMessages } from "./i18n/de.js";
import fs from "node:fs/promises";
import path from "node:path";
import { problem } from "./storage.js";
export function directoryResolver(home) {
  const directory = async (value) => {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 4096 ||
      value.includes("\0")
    )
      throw problem(serverMessages.common.workingDirectoryRequired);
    const p =
      value === "~"
        ? home
        : value.startsWith("~/")
          ? path.join(home, value.slice(2))
          : value;
    if (!path.isAbsolute(p))
      throw problem(serverMessages.common.absoluteDirectoryRequired);
    try {
      const real = await fs.realpath(p);
      if (!(await fs.stat(real)).isDirectory()) throw Error();
      return real;
    } catch {
      throw problem(serverMessages.common.workingDirectoryUnavailable);
    }
  };
  return directory;
}
export async function listDirectories(directory) {
  const found = await fs.readdir(directory, { withFileTypes: true });
  const entries = found
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500)
    .map((entry) => ({
      name: entry.name,
      path: path.join(directory, entry.name),
    }));
  return {
    path: directory,
    parent: path.dirname(directory) === directory ? null : path.dirname(directory),
    entries,
  };
}

export async function createDirectory(parent, name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name !== name.trim() ||
    Buffer.byteLength(name) > 255 ||
    /[/\\\x00-\x1f\x7f]/.test(name) ||
    [".", ".."].includes(name)
  )
    throw problem(filesCopy.invalidName);
  const target = path.join(parent, name);
  try {
    await fs.mkdir(target, { mode: 0o700 });
  } catch (error) {
    throw problem(
      error.code === "EEXIST" ? filesCopy.exists : filesCopy.createFailed,
      error.code === "EEXIST" ? 409 : 400,
    );
  }
  return { path: target };
}
