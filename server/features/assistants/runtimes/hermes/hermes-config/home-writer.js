import fs from "node:fs";
import path from "node:path";
import { privateFolder, writePrivateText } from "../../../../../lib/storage.js";
import { mergeConfig, mergeEnv } from "./home-merge.js";

const unsafe = (where) => () =>
  Object.assign(new Error(`Unsafe Hermes home folder: ${where}`), {
    code: "HERMES_HOME_UNSAFE",
  });

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

// A path the home names, inside `dir` (compiled paths are relative and fixed; this
// keeps a later change from writing or removing outside the home).
function inside(dir, relative) {
  const file = path.resolve(dir, relative);
  if (!file.startsWith(`${dir}${path.sep}`)) throw unsafe(relative)();
  return file;
}

// Creates the owner-only folders on the way to `file`, never through a link.
function folderFor(dir, file) {
  let folder = dir;
  for (const part of path
    .relative(dir, path.dirname(file))
    .split(path.sep)
    .filter(Boolean))
    privateFolder((folder = path.join(folder, part)), unsafe(part));
}

/**
 * Writes a compiled Hermes home (home.js compileHome) into the folder `dir`
 * (absolute; created owner-only): config.yaml and .env merged again over what Hermes
 * left there at this moment, AgentPier's other files replaced, its stale paths
 * removed. Writes only what changes, each file atomically and owner-only, and
 * returns the relative paths it wrote or removed, sorted.
 */
export function writeHermesHome(folder, home) {
  if (!path.isAbsolute(folder))
    throw new TypeError("A Hermes home needs an absolute path.");
  const dir = path.resolve(folder);
  privateFolder(dir, unsafe(dir));
  const changed = [];
  const next = (relative, current) => {
    if (relative === "config.yaml") return mergeConfig(current, home.config);
    if (relative === ".env") return mergeEnv(current, home.env.owned, home.env.values);
    return home.files[relative];
  };
  for (const relative of Object.keys(home.files)) {
    const file = inside(dir, relative);
    const current = readText(file);
    const text = next(relative, current);
    if (text === current) continue;
    folderFor(dir, file);
    writePrivateText(file, text);
    changed.push(relative);
  }
  for (const relative of home.remove) {
    const target = inside(dir, relative);
    if (!fs.lstatSync(target, { throwIfNoEntry: false })) continue;
    fs.rmSync(target, { recursive: true, force: true });
    changed.push(relative);
  }
  return changed.sort();
}
