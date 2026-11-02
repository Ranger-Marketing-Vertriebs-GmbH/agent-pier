import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { hermesError } from "./hermes-rpc-client.js";
import { boundPort } from "./hermes-connection.js";
import { hermesExecutables } from "./hermes-paths.js";
import { readHermesConfig } from "./hermes-config/home-merge.js";
import { essentialSkills } from "./hermes-config/skills.js";
import { teamDirectory } from "./hermes-config/team-plugin.js";

// What Hermes offers one agent of its skills (hermes-config/skills.js), read from the
// installation and the agent's home as Hermes reads them (v0.22.5): bundled skills in
// `<install>/src/skills/<category>/<name>/SKILL.md`, seeded into `<HERMES_HOME>/skills/`
// and recorded in its `.bundled_manifest` (tools/skills_sync.py), skills the agent
// wrote or installed there, and the folders of `skills.external_dirs`.

// Folders Hermes never scans for skills (agent/skill_utils.py EXCLUDED_SKILL_DIRS,
// SKILL_SUPPORT_DIRS below a skill), and the walk's bound.
const excluded = new Set([
  ".git",
  ".github",
  ".hub",
  ".archive",
  ".curator_backups",
  ".locks",
  ".venv",
  "venv",
  "node_modules",
  "site-packages",
  "__pycache__",
]);
const support = new Set(["references", "templates", "assets", "scripts"]);
const maxDepth = 4;
const maxSkills = 500;
// Hermes's platform names (agent/skill_utils.py PLATFORM_MAP).
const platforms = { macos: "darwin", linux: "linux", windows: "win32" };

const list = (value) =>
  (Array.isArray(value) ? value : value == null ? [] : [value])
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map(String);

// A SKILL.md's frontmatter, or {} for one without (Hermes falls back to the folder
// name then, tools/skill_usage.py read_skill_name).
function frontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").slice(0, 16384);
  } catch {
    return null;
  }
  const match = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const value = parse(match[1], { version: "1.1" });
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Each skill below `root`: `{ name, dir, file, meta }`, as Hermes walks the folder. */
export function scanSkills(root) {
  const found = [];
  if (!root) return found;
  const walk = (dir, depth) => {
    if (found.length >= maxSkills) return;
    let entries;
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    const skill = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (skill) {
      const file = path.join(dir, "SKILL.md");
      const meta = frontmatter(file);
      if (meta) {
        const name = typeof meta.name === "string" && meta.name.trim();
        found.push({ name: name || path.basename(dir), dir, file, meta });
      }
    }
    if (depth >= maxDepth) return;
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !excluded.has(entry.name) &&
        !(skill && support.has(entry.name))
      )
        walk(path.join(dir, entry.name), depth + 1);
  };
  walk(root, 0);
  return found;
}

/**
 * The skills folder an installed runtime bundles (hermes-paths.js hermesExecutables),
 * or null for a record without its directory.
 */
export const bundledSkillsDir = (record) =>
  typeof record?.directory === "string"
    ? path.join(hermesExecutables(record.directory).source, "skills")
    : null;

/** The names of the skills an installed runtime bundles, sorted. */
export const bundledSkillNames = (record) =>
  [...new Set(scanSkills(bundledSkillsDir(record)).map((skill) => skill.name))].sort();

// The names the home's `.bundled_manifest` records ("name:hash" lines, or names).
function manifestNames(hermesHome) {
  try {
    return new Set(
      fs
        .readFileSync(path.join(hermesHome, "skills", ".bundled_manifest"), "utf8")
        .split("\n")
        .map((line) => line.split(":")[0].trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function readConfig(hermesHome) {
  try {
    return readHermesConfig(
      fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8"),
    );
  } catch {
    return {};
  }
}

// The names a .env sets (values are never read into the report).
function envNames(hermesHome) {
  try {
    return new Set(
      fs
        .readFileSync(path.join(hermesHome, ".env"), "utf8")
        .split("\n")
        .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

const onPath = (bin, folders) =>
  folders.some((folder) => {
    try {
      fs.accessSync(path.join(folder, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/**
 * One skill as the skills sub-port reports it, in the fields agent-skills.js reads:
 * `origin` ("bundled", "catalog", "builtIn" or "local", a skill the agent wrote or installed in
 * Hermes), `essential` (a bundled skill Hermes always offers), `blockedByAgentFilter` (`skills.disabled` names it), what it requires
 * (prerequisites.commands as `bins`, required_environment_variables as `env`,
 * `platforms` as `os`) and what of it is missing on this host.
 */
function entryOf(skill, origin, { disabled, env, folders, platform }) {
  const { meta } = skill;
  const wanted = list(meta.platforms).map((p) => p.toLowerCase().trim());
  const incompatible =
    wanted.length > 0 && !wanted.some((p) => platform.startsWith(platforms[p] || p));
  const bins = list(meta.prerequisites?.commands);
  const envs = (
    Array.isArray(meta.required_environment_variables)
      ? meta.required_environment_variables
      : []
  )
    .map((item) => (typeof item === "string" ? item : item?.name))
    .filter((name) => typeof name === "string");
  const missing = {
    bins: bins.filter((bin) => !onPath(bin, folders)),
    anyBins: [],
    env: envs.filter((name) => !env.has(name)),
    config: [],
    os: incompatible ? wanted : [],
  };
  const essential = essentialSkills.includes(skill.name);
  const blocked = disabled.has(skill.name) && !essential;
  return {
    name: skill.name,
    description: typeof meta.description === "string" ? meta.description : "",
    source: `hermes-${origin}`,
    origin,
    // Hermes needs it: always offered, never switched (hermes-config/skills.js).
    ...(essential && origin === "bundled" && { essential: true }),
    filePath: skill.file,
    eligible: !incompatible && !Object.values(missing).some((names) => names.length),
    disabled: false,
    blockedByAgentFilter: blocked,
    platformIncompatible: incompatible,
    requirements: { bins, anyBins: [], env: envs, config: [], os: wanted },
    missing,
  };
}

/**
 * The skills Hermes offers the agent in `agent` (its hermesPaths folders) with the
 * installation `record`: every bundled skill, every skill in its home and each
 * folder of `skills.external_dirs` (AgentPier's catalog skills), in Hermes's order
 * of precedence (home before external). `folders`: the agent's PATH.
 */
export function skillReport(
  agent,
  record,
  { folders = [], platform = process.platform } = {},
) {
  const config = readConfig(agent.hermesHome);
  const facts = {
    disabled: new Set(list(config.skills?.disabled)),
    env: envNames(agent.hermesHome),
    folders,
    platform,
  };
  const bundled = new Map(
    scanSkills(bundledSkillsDir(record)).map((skill) => [skill.name, skill]),
  );
  const seeded = manifestNames(agent.hermesHome);
  const skills = [];
  const seen = new Set();
  const add = (skill, origin) => {
    skills.push(entryOf(skill, origin, facts));
    seen.add(skill.name);
  };
  for (const skill of scanSkills(path.join(agent.hermesHome, "skills")))
    add(skill, bundled.has(skill.name) || seeded.has(skill.name) ? "bundled" : "local");
  // A bundled skill not seeded yet (before the first start) is still Hermes's.
  for (const skill of bundled.values()) if (!seen.has(skill.name)) add(skill, "bundled");
  // Hermes reads a relative folder below HERMES_HOME; AgentPier's built-in skills
  // stand in the team plugin's folder there (hermes-config/skills.js builtInOffered).
  const plugin = path.join(agent.hermesHome, teamDirectory);
  for (const entry of list(config.skills?.external_dirs)) {
    const dir = path.resolve(agent.hermesHome, entry);
    const builtIn = dir.startsWith(plugin + path.sep);
    for (const skill of scanSkills(dir)) add(skill, builtIn ? "builtIn" : "catalog");
  }
  return { skills };
}

const unknownAgent = (error) => error?.code === "UNKNOWN_AGENT";

/**
 * The skills sub-port (../agent-runtime.js) of one Hermes agent over its supervisor:
 * status({ agentId }) reports skillReport for the set's own agent (UNKNOWN_AGENT for
 * any other), status() the installation's bundled skills alone. Rejects while the
 * set is not ready; views bound to a replaced connection reach nothing.
 * `installed()`: the installation record the running set started with.
 */
export const hermesSkills = (supervisor, { installed, folders = () => [] }) =>
  boundPort((current) => skillsOver(current, supervisor, installed, folders), supervisor);

function skillsOver(current, supervisor, installed, folders) {
  return {
    async status({ agentId } = {}) {
      const record = current()?.ready ? installed() : null;
      if (!record) throw hermesError();
      if (agentId === undefined) {
        const skills = scanSkills(bundledSkillsDir(record)).map((skill) =>
          entryOf(skill, "bundled", {
            disabled: new Set(),
            env: new Set(),
            folders: folders(record),
            platform: process.platform,
          }),
        );
        return { skills };
      }
      if (agentId !== supervisor.agentId)
        throw Object.assign(Error(`unknown agent id "${agentId}"`), {
          code: "UNKNOWN_AGENT",
          status: 404,
        });
      return skillReport(supervisor.agentPaths(), record, { folders: folders(record) });
    },
    unknownAgent,
  };
}
