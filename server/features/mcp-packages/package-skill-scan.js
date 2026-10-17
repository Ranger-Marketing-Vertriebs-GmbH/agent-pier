import fs from "node:fs";
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
const skipped = new Set(["node_modules", ".git"]);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The files of the skill in `dir` as [relative path, content, mode], or null: only
 * regular files and folders (no link, no nested node_modules), within the limits of
 * an uploaded skill, valid metadata and no plugin or MCP configuration.
 */
function readSkill(dir) {
  const files = [];
  let size = 0;
  const collect = (folder, relative, depth) => {
    if (depth > MAX_DEPTH) throw Error("too deep");
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort(byName)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (skipped.has(entry.name)) throw Error("nested package");
        collect(file, name, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw Error("special file");
      const stat = fs.lstatSync(file);
      size += stat.size;
      if (files.length >= MAX_FILES || size > MAX_EXPANDED) throw Error("too large");
      files.push([name, fs.readFileSync(file), stat.mode & 0o111 ? 0o700 : 0o600]);
    }
  };
  try {
    collect(dir, "", 0);
    assertPortableSkill(files);
    const document = files.find(([name]) => name === "SKILL.md");
    return { ...skillMetadata(document[1]), files, size };
  } catch {
    return null;
  }
}

/**
 * The skills an installed package ships: every folder with a SKILL.md, read from the
 * install of the locked tarball. Links are never followed; a folder that is a skill is
 * not searched further. Invalid skills and names found twice are not offered.
 */
export function bundledSkills(root) {
  const found = [];
  let folders = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || ++folders > MAX_FOLDERS || found.length >= MAX_SKILLS)
      return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
      const skill = readSkill(dir);
      if (skill) found.push(skill);
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !skipped.has(entry.name))
        walk(path.join(dir, entry.name), depth + 1);
  };
  walk(root, 0);
  return found.filter(
    (skill) => found.filter((other) => other.name === skill.name).length === 1,
  );
}
