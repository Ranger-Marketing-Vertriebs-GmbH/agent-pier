import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  MAX_EXPANDED,
  assertPortableSkill,
  skillMetadata,
} from "../extensions/skill-packages.js";

const MAX_DEPTH = 6;
const MAX_FOLDERS = 2000;
const MAX_SKILLS = 50;
const MAX_FILES = 1000;
// All offered skills together: a package cannot make one listing read without bound.
const MAX_TOTAL = 100 * 1024 * 1024;
const MAX_TOTAL_FILES = 5000;
const MAX_DOCUMENT = 256 * 1024;
const skipped = new Set(["node_modules", ".git"]);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * A regular file read through a handle that refuses links (O_NOFOLLOW): only what the
 * handle's own stat names, never a file with a second hard link, at most `limit` bytes.
 */
async function readFile(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw Error("not a plain file");
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(data, offset, stat.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return { data: data.subarray(0, offset), mode: stat.mode };
  } finally {
    await handle.close();
  }
}

/**
 * The entries of the skill in `dir` (name, size, mode; `content` adds the data): only
 * regular files with one link and folders (no link, no nested node_modules), within
 * the limits of an uploaded skill. Throws for anything else.
 */
async function collect(dir, content) {
  const files = [];
  let size = 0;
  const walk = async (folder, relative, depth) => {
    if (depth > MAX_DEPTH) throw Error("too deep");
    const entries = (await fs.readdir(folder, { withFileTypes: true })).sort(byName);
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (skipped.has(entry.name)) throw Error("nested package");
        await walk(file, name, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw Error("special file");
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1) throw Error("linked file");
      size += stat.size;
      if (files.length >= MAX_FILES || size > MAX_EXPANDED) throw Error("too large");
      const read = content || name === "SKILL.md";
      const limit = name === "SKILL.md" ? MAX_DOCUMENT : MAX_EXPANDED;
      const found = read ? await readFile(file, limit) : null;
      if (found && found.data.length !== stat.size) throw Error("changed");
      files.push({
        name,
        size: stat.size,
        mode: stat.mode & 0o111 ? 0o700 : 0o600,
        data: found?.data,
      });
    }
  };
  await walk(dir, "", 0);
  assertPortableSkill(files.map((file) => [file.name]));
  const document = files.find((file) => file.name === "SKILL.md");
  if (!document) throw Error("no document");
  return { ...skillMetadata(document.data), document: document.data, files, size };
}

/**
 * The skills an installed package ships: every folder with a SKILL.md, read from the
 * install of the locked tarball. Only names, sizes and SKILL.md are read; links are
 * never followed; a folder that is a skill is not searched further. Invalid skills,
 * names found twice and skills beyond the overall limits are not offered.
 */
export async function bundledSkills(root) {
  const found = [];
  let folders = 0;
  let total = 0;
  let totalFiles = 0;
  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH || ++folders > MAX_FOLDERS || found.length >= MAX_SKILLS)
      return;
    let entries;
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })).sort(byName);
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
      try {
        const skill = await collect(dir, false);
        total += skill.size;
        totalFiles += skill.files.length;
        if (total <= MAX_TOTAL && totalFiles <= MAX_TOTAL_FILES)
          found.push({
            name: skill.name,
            description: skill.description,
            document: skill.document.toString("utf8"),
            files: skill.files.map((file) => file.name),
            size: skill.size,
            dir,
          });
      } catch {
        /* Not a portable skill: not offered. */
      }
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !skipped.has(entry.name))
        await walk(path.join(dir, entry.name), depth + 1);
  };
  await walk(root, 0);
  return found.filter(
    (skill) => found.filter((other) => other.name === skill.name).length === 1,
  );
}

/**
 * The files of an offered skill, read now with the same checks; refused when the
 * folder no longer holds the skill that was offered under this name.
 */
export async function skillPack(skill) {
  const read = await collect(skill.dir, true);
  if (read.name !== skill.name) throw Error("changed");
  return {
    name: read.name,
    description: read.description,
    files: read.files.map((file) => [file.name, file.data, file.mode]),
  };
}
