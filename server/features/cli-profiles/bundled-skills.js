import fs from "node:fs";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { safePath } from "../extensions/mcp-config.js";

const skills = ["agentpier-composer"];

// Seed once per native profile. Existing packages and later deletions belong to
// the user; a release or another account launch must not replace those choices.
export function seedBundledSkills(dataDir, target) {
  const file = path.join(dataDir, "bundled-skills.json");
  const state = readJSON(file, {});
  const saved = (state[target.root] ||= []);
  for (const name of skills) {
    if (saved.includes(name)) continue;
    const parent = path.join(target.root, "skills");
    safePath(parent, target.boundary);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const directory = path.join(parent, name);
    let created = false;
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (created) {
      try {
        fs.copyFileSync(
          new URL(`./skills/${name}/SKILL.md`, import.meta.url),
          path.join(directory, "SKILL.md"),
          fs.constants.COPYFILE_EXCL,
        );
        fs.chmodSync(path.join(directory, "SKILL.md"), 0o600);
      } catch (error) {
        // Remove only an empty directory we just created, never another package.
        try {
          fs.rmdirSync(directory);
        } catch {
          // Retain any content written before the failure.
        }
        throw error;
      }
    }
    saved.push(name);
    writePrivate(file, state);
  }
}
