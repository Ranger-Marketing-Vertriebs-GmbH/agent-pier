// Dependencies a manifest declares, by ecosystem. The risk gate compares the entries
// before and after a run's change; an entry that only exists afterwards is an added
// dependency. A version change of a registry dependency is no new entry, but a
// dependency that now comes from another source (git, a URL, a local path, an
// override or a replacement) is. The path rules stay the primary control: lockfiles
// and unlisted manifests are only covered by them.
const base = (file) => file.split("/").at(-1).toLowerCase();

const jsonSections = {
  "package.json": [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "overrides",
    "resolutions",
  ],
  "composer.json": ["require", "require-dev"],
};

/** Whether `file` is a manifest whose dependencies the risk gate reads. */
export function dependencyManifest(file) {
  const name = base(file);
  return (
    Object.hasOwn(jsonSections, name) ||
    /^requirements.*\.txt$/.test(name) ||
    ["go.mod", "cargo.toml", "gemfile", "pyproject.toml", "pipfile"].includes(name)
  );
}

// A specifier that fetches from somewhere other than the registry.
const sourceSpecifier =
  /^(?:npm:|git(?:\+|:)|github:|gitlab:|bitbucket:|file:|link:|https?:|\.{0,2}\/)|^[\w.-]+\/[\w.-]+(?:#.*)?$/i;

function jsonNames(text, sections) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("json");
  return sections.flatMap((key) => {
    const section = value[key];
    if (!section || typeof section !== "object" || Array.isArray(section)) return [];
    return Object.entries(section).map(([name, spec]) =>
      key === "overrides" || key === "resolutions"
        ? `${name} (${key})`
        : typeof spec === "string" && sourceSpecifier.test(spec.trim())
          ? `${name}@${spec.trim()}`
          : name,
    );
  });
}

const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/(?:^|\s+)#(?!egg=).*$/, "").trim())
    .filter(Boolean);

// pip names ignore case, and `-`, `_` and `.` are the same character. A requirement
// from a URL, a local path or another requirements file counts as its whole line.
function requirementName(entry) {
  const line = entry.trim();
  const egg = /#egg=([A-Za-z0-9._-]+)/.exec(line);
  const direct = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*@\s*(\S+)/.exec(line);
  if (direct) return `${normalize(direct[1])}@${direct[2]}`;
  if (line.startsWith("-") || /:\/\/|^git\+|^\.{0,2}\//.test(line))
    return egg ? `${normalize(egg[1])}@${line}` : line;
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(line)?.[0];
  return name ? normalize(name) : null;
}
const normalize = (name) => name.toLowerCase().replace(/[._-]+/g, "-");
const requirementNames = (text) => lines(text).map(requirementName).filter(Boolean);

function goNames(text) {
  const names = [];
  let block = "";
  for (const line of lines(text.replace(/\/\/.*$/gm, ""))) {
    if (block) {
      if (line === ")") block = "";
      else names.push(block === "replace" ? `replace ${line}` : line.split(/\s+/)[0]);
    } else if (/^(require|replace)\s*\($/.test(line)) block = line.split(/\s|\(/)[0];
    else if (/^require\s+\S/.test(line)) names.push(line.split(/\s+/)[1]);
    else if (/^replace\s+\S/.test(line)) names.push(`replace ${line.slice(8).trim()}`);
  }
  return names;
}

// Keys of the TOML tables whose header `inSection` accepts, with dotted keys
// (`serde.workspace = true`) and table headers (`[dependencies.serde]`) included.
function tomlKeys(text, inSection, sourceKeys = []) {
  const names = [];
  let section = "";
  for (const line of lines(text)) {
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      section = header[1].replace(/"/g, "");
      const parts = section.split(".");
      if (parts.length > 1 && inSection(parts.slice(0, -1).join(".")))
        names.push(parts.at(-1));
      continue;
    }
    if (!inSection(section)) continue;
    const key = /^"?([A-Za-z0-9_.-]+?)"?\s*(?:\.[A-Za-z0-9_-]+\s*)?=\s*(.*)$/.exec(line);
    if (!key) continue;
    const name = key[1].split(".")[0];
    const source = sourceKeys.find((k) => new RegExp(`\\b${k}\\s*=`).test(key[2]));
    names.push(source ? `${name}@${source}` : name);
  }
  return names;
}

const cargoNames = (text) =>
  tomlKeys(text, (section) => /(?:^|\.)(?:dev-|build-)?dependencies$/.test(section), [
    "git",
    "path",
  ]);

const pipfileNames = (text) =>
  tomlKeys(text, (section) => ["packages", "dev-packages"].includes(section), [
    "git",
    "path",
    "file",
  ]).map((name) => (name.includes("@") ? name : normalize(name)));

// PEP 621 arrays (`dependencies`, optional dependency groups) and Poetry tables.
function pyprojectNames(text) {
  const names = tomlKeys(
    text,
    (section) =>
      /^tool\.poetry\.(?:dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.test(
        section,
      ),
    ["git", "path", "url"],
  ).filter((name) => name !== "python");
  let section = "",
    collecting = false;
  for (const line of lines(text)) {
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      section = header[1];
      collecting = false;
      continue;
    }
    const opens =
      (section === "project" && /^dependencies\s*=\s*\[/.test(line)) ||
      (section === "project.optional-dependencies" && /^[\w.-]+\s*=\s*\[/.test(line));
    if (opens) collecting = true;
    if (!collecting) continue;
    for (const match of line.matchAll(/["']([^"']+)["']/g)) {
      const name = requirementName(match[1]);
      if (name) names.push(name);
    }
    if (line.includes("]")) collecting = false;
  }
  return names;
}

const gemNames = (text) =>
  lines(text).flatMap((line) => {
    const gem = /^gem\s+["']([^"']+)["'](.*)$/.exec(line);
    if (!gem) return [];
    const source = /\b(git|github|path):/.exec(gem[2]);
    return [source ? `${gem[1]}@${source[1]}` : gem[1]];
  });

/** The dependency entries `text` of manifest `file` declares; throws when unreadable. */
export function dependencyNames(file, text) {
  const name = base(file);
  if (Object.hasOwn(jsonSections, name)) return jsonNames(text, jsonSections[name]);
  if (name === "go.mod") return goNames(text);
  if (name === "cargo.toml") return cargoNames(text);
  if (name === "gemfile") return gemNames(text);
  if (name === "pyproject.toml") return pyprojectNames(text);
  if (name === "pipfile") return pipfileNames(text);
  return requirementNames(text);
}

/**
 * Entries `after` declares that `before` did not, sorted. A manifest that exists
 * afterwards but cannot be read or parsed yields `[""]`: the gate cannot rule out an
 * added dependency. Pass `undefined` for a side that could not be read and `null` for
 * a side where the file does not exist; an unreadable earlier side counts as empty.
 */
export function addedDependencies(file, before, after) {
  if (after === null) return [];
  if (after === undefined) return [""];
  let next;
  try {
    next = new Set(dependencyNames(file, after));
  } catch {
    return [""];
  }
  let previous = new Set();
  try {
    if (typeof before === "string") previous = new Set(dependencyNames(file, before));
  } catch {
    // An unreadable earlier manifest declares nothing to compare against.
  }
  return [...next].filter((name) => !previous.has(name)).sort();
}
