import path from "node:path";
import {
  field,
  inside,
  isLink,
  markdownDocuments,
  readFrontmatter,
  readJsonFile,
  skillFolders,
} from "./slash-discovery-files.js";

// Claude Code's own slash commands beyond its built-ins, as Claude Code finds them:
// custom commands and skills of the profile (CLAUDE_CONFIG_DIR) and of the project
// (`.claude/` in the session folder), and the commands and skills of enabled plugins.
// MCP prompts need a live server connection and are not discovered.

const PLUGIN_ID = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99})@[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** A command document's name: subfolders organise, they do not name. */
const commandName = (relative) => relative.split("/").at(-1);

async function addCommands(scan, directory, { scope, plugin, links }) {
  for (const document of await markdownDocuments(directory, { scan, links })) {
    const metadata = await readFrontmatter(document.path, { scan, links });
    if (!metadata) continue;
    const name = commandName(document.relative);
    scan.add({
      name: plugin ? `${plugin}:${name}` : name,
      description: field(metadata, "description"),
      argumentHint: field(metadata, "argument-hint"),
      kind: "command",
      scope,
      plugin,
    });
  }
}

async function addSkills(scan, directory, { scope, plugin, links }) {
  for (const { folder, file } of await skillFolders(directory, { scan, links })) {
    const metadata = await readFrontmatter(file, { scan, links });
    // A skill only the model may use does not appear in the slash menu.
    if (!metadata || metadata["user-invocable"] === false) continue;
    const name = field(metadata, "name") || path.basename(folder);
    scan.add({
      name: plugin ? `${plugin}:${name}` : name,
      description: field(metadata, "description"),
      argumentHint: field(metadata, "argument-hint"),
      kind: "skill",
      scope,
      plugin,
    });
  }
}

/** Plugin ids switched on: user settings, then project, then local settings win. */
async function enabledPlugins(scan, root, cwd) {
  const enabled = new Map();
  const files = [path.join(root, "settings.json")];
  if (cwd)
    files.push(
      path.join(cwd, ".claude", "settings.json"),
      path.join(cwd, ".claude", "settings.local.json"),
    );
  for (const file of files) {
    const settings = await readJsonFile(file, scan);
    const plugins = settings?.enabledPlugins;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) continue;
    for (const [id, value] of Object.entries(plugins))
      if (PLUGIN_ID.test(id) && typeof value === "boolean") enabled.set(id, value);
  }
  return [...enabled].filter(([, on]) => on).map(([id]) => id);
}

/** The installation of a plugin that applies to this project, or null. */
function installation(record, cwd) {
  const entries = (Array.isArray(record) ? record : [record]).filter(
    (entry) =>
      entry &&
      typeof entry.installPath === "string" &&
      path.isAbsolute(entry.installPath),
  );
  const project = cwd
    ? entries.find(
        (entry) =>
          ["project", "local"].includes(entry.scope) &&
          typeof entry.projectPath === "string" &&
          path.resolve(entry.projectPath) === path.resolve(cwd),
      )
    : null;
  return (
    project || entries.find((entry) => !entry.scope || entry.scope === "user") || null
  );
}

/** Extra command or skill paths a plugin manifest names, inside the plugin only. */
function manifestPaths(installPath, value) {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return list
    .filter((item) => typeof item === "string" && item.length <= 512)
    .map((item) => path.resolve(installPath, item))
    .filter((item) => inside(installPath, item))
    .slice(0, 100);
}

async function addPlugins(scan, root, cwd) {
  const ids = await enabledPlugins(scan, root, cwd);
  if (!ids.length) return;
  const installed = await readJsonFile(
    path.join(root, "plugins", "installed_plugins.json"),
    scan,
  );
  const records = installed?.plugins;
  if (!records || typeof records !== "object") return;
  for (const id of ids) {
    if (!Object.hasOwn(records, id)) continue;
    const entry = installation(records[id], cwd);
    if (!entry) continue;
    const base = entry.installPath;
    const manifest =
      (await readJsonFile(path.join(base, ".claude-plugin", "plugin.json"), scan)) || {};
    const plugin =
      typeof manifest.name === "string" && PLUGIN_ID.test(`${manifest.name}@x`)
        ? manifest.name
        : PLUGIN_ID.exec(id)[1];
    const options = { scope: "plugin", plugin, links: true };
    for (const directory of [
      path.join(base, "commands"),
      ...manifestPaths(base, manifest.commands),
    ])
      if (/\.md$/i.test(directory)) {
        const metadata = await readFrontmatter(directory, { scan });
        if (metadata)
          scan.add({
            name: `${plugin}:${path.basename(directory, path.extname(directory))}`,
            description: field(metadata, "description"),
            argumentHint: field(metadata, "argument-hint"),
            kind: "command",
            scope: "plugin",
            plugin,
          });
      } else await addCommands(scan, directory, options);
    for (const directory of [
      path.join(base, "skills"),
      ...manifestPaths(base, manifest.skills),
    ])
      await addSkills(scan, directory, options);
  }
}

/**
 * Claude Code's discoverable commands. The profile belongs to the owner, so its
 * symbolic links (shared profiles link to ~/.claude) are followed; a project's are
 * not, so a repository cannot point discovery at files outside it.
 */
export async function discoverClaude(scan, { root, cwd }) {
  await addCommands(scan, path.join(root, "commands"), { scope: "user", links: true });
  await addSkills(scan, path.join(root, "skills"), { scope: "user", links: true });
  const project = cwd && path.join(cwd, ".claude");
  if (project && !(await isLink(project))) {
    await addCommands(scan, path.join(project, "commands"), {
      scope: "project",
      links: false,
    });
    await addSkills(scan, path.join(project, "skills"), {
      scope: "project",
      links: false,
    });
  }
  await addPlugins(scan, root, cwd);
}
