import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safePath, readConfig, atomicText } from "../extensions/mcp-config.js";
import { merge } from "./configuration.js";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";

export function assetDirectories(tool) {
  return [
    "skills",
    "agents",
    "commands",
    "plugins",
    ...(tool === "codex" ? [".tmp/marketplaces"] : tool === "opencode" ? ["plugin"] : []),
  ];
}
function rewrite(value, source, target) {
  if (typeof value === "string")
    return value === source || value.startsWith(source + path.sep)
      ? target + value.slice(source.length)
      : value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, source, target));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewrite(item, source, target)]),
    );
  return value;
}
export function importAssets(source, target, conflicts) {
  const copiedSkills = new Set();
  let count = 0,
    bytes = 0;
  // Validate the complete import before copying, including its size and link boundaries.
  const inspect = (from, to) => {
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink()) return;
    safePath(from, source.boundary);
    safePath(to, target.boundary);
    if (++count > 30000 || (bytes += info.isFile() ? info.size : 0) > 512 * 1024 * 1024)
      throw problem(
        "Extension import exceeds its file limit; existing files were retained.",
        409,
      );
    if (info.isDirectory()) {
      if (fs.existsSync(to) && !fs.statSync(to).isDirectory()) return;
      for (const name of fs.readdirSync(from))
        inspect(path.join(from, name), path.join(to, name));
    } else if (
      info.isFile() &&
      /\/(?:installed_plugins|known_marketplaces)\.json$/.test(from)
    ) {
      readConfig(from, source.boundary, "claude");
      readConfig(to, target.boundary, "claude");
    }
  };
  const copy = (from, to) => {
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink()) {
      try {
        if (fs.realpathSync(from) !== to) conflicts.push(from);
      } catch {
        conflicts.push(from);
      }
      return;
    }
    safePath(from, source.boundary);
    safePath(to, target.boundary);
    if (info.isDirectory()) {
      if (fs.existsSync(to) && !fs.statSync(to).isDirectory()) {
        conflicts.push(from);
        return;
      }
      if (path.dirname(from) === path.join(source.root, "skills")) {
        // A skill is one package: never combine two implementations or take ownership
        // of a pre-existing native skill merely because their directory names match.
        if (fs.existsSync(to)) {
          conflicts.push(from);
          return;
        }
        copiedSkills.add(from);
      }
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(from))
        copy(path.join(from, name), path.join(to, name));
      return;
    }
    if (!info.isFile() || info.nlink !== 1) {
      conflicts.push(from);
      return;
    }
    let content = fs.readFileSync(from);
    if (/\/(?:installed_plugins|known_marketplaces)\.json$/.test(from)) {
      const incoming = rewrite(
        readConfig(from, source.boundary, "claude").data,
        source.root,
        target.root,
      );
      const current = readConfig(to, target.boundary, "claude");
      atomicText(
        to,
        target.boundary,
        current.text,
        JSON.stringify(merge(current.data, incoming), null, 2) + "\n",
      );
      return;
    }
    if (fs.existsSync(to)) {
      if (!fs.readFileSync(to).equals(content)) conflicts.push(from);
      return;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.writeFileSync(to, content, {
      flag: "wx",
      mode: info.mode & 0o111 ? 0o700 : 0o600,
    });
  };
  for (const name of assetDirectories(source.account.tool)) {
    const from = path.join(source.root, name),
      to = path.join(target.root, name);
    if (fs.existsSync(from)) inspect(from, to);
  }
  for (const name of assetDirectories(source.account.tool)) {
    const from = path.join(source.root, name),
      to = path.join(target.root, name);
    if (fs.existsSync(from)) copy(from, to);
  }
  return copiedSkills;
}
export function linkAssets(source, target) {
  for (const name of assetDirectories(source.account.tool)) {
    const from = path.join(source.root, name),
      to = path.join(target.root, name);
    safePath(from, source.boundary);
    fs.mkdirSync(from, { recursive: true, mode: 0o700 });
    safePath(path.dirname(to), target.boundary);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    let info;
    try {
      info = fs.lstatSync(to);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (info?.isSymbolicLink()) {
      if (fs.realpathSync(to) === fs.realpathSync(from)) continue;
      throw problem("An extension directory points to an unexpected location.", 409);
    }
    if (info) fs.renameSync(to, `${to}.before-sharing-${randomUUID()}`);
    fs.symlinkSync(from, to, "dir");
  }
}

export function rebaseExtensions(values, source, target) {
  let result = values;
  for (const name of assetDirectories(source.account.tool))
    result = rewrite(result, path.join(source.root, name), path.join(target.root, name));
  return result;
}
export function migrateSkillRecords(dataDir, source, target, copiedSkills) {
  const file = path.join(dataDir, "extension-skills.json");
  const records = readJSON(file, []);
  let changed = false;
  const migrated = records.map((record) => {
    if (typeof record.path !== "string" || !copiedSkills.has(record.path)) return record;
    const destination = target.root + record.path.slice(source.root.length);
    safePath(destination, target.boundary);
    if (!fs.existsSync(destination)) return record;
    const info = fs.lstatSync(destination);
    changed = true;
    return {
      ...record,
      accountId: target.account.id,
      path: destination,
      dev: info.dev,
      ino: info.ino,
    };
  });
  if (changed)
    writePrivate(file, [
      ...new Map(migrated.map((record) => [record.path, record])).values(),
    ]);
}
