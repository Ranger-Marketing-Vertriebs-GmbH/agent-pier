import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
  field,
  isLink,
  listDirectory,
  markdownDocuments,
  readFrontmatter,
} from "./slash-discovery-files.js";

// Codex and OpenCode commands beyond their built-ins. Codex: custom prompts in
// CODEX_HOME/prompts, invoked as /prompts:<name> (skills are mentioned with `$`, not
// slash commands). OpenCode: Markdown commands in its config folder and in the
// project's .opencode folder, and the `command` entries of its JSON config.

export async function discoverCodex(scan, { root }) {
  for (const entry of await listDirectory(path.join(root, "prompts"), { scan })) {
    if (!entry.file || !/\.md$/i.test(entry.name)) continue;
    const metadata = await readFrontmatter(entry.path, { scan });
    if (!metadata) continue;
    scan.add({
      name: `prompts:${entry.name.slice(0, -3)}`,
      description: field(metadata, "description"),
      argumentHint: field(metadata, "argument-hint"),
      kind: "prompt",
      scope: "user",
    });
  }
}

async function readJsonc(file, scan) {
  scan.watch(file);
  try {
    const text = await fs.readFile(file, "utf8");
    if (text.length > 4 * 1024 * 1024) return null;
    const value = parseJsonc(text, [], { allowTrailingComma: true });
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function addOpenCodeFolder(scan, folder, { scope, links }) {
  for (const name of ["command", "commands"])
    for (const document of await markdownDocuments(path.join(folder, name), {
      scan,
      links,
    })) {
      const metadata = await readFrontmatter(document.path, { scan, links });
      if (!metadata) continue;
      scan.add({
        name: document.relative,
        description: field(metadata, "description"),
        kind: "command",
        scope,
      });
    }
  await addConfigCommands(scan, folder, scope);
}

/** The `command` entries of opencode.json(c) in `folder`. */
async function addConfigCommands(scan, folder, scope) {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const config = await readJsonc(path.join(folder, name), scan);
    const commands = config?.command;
    if (!commands || typeof commands !== "object" || Array.isArray(commands)) continue;
    for (const [command, value] of Object.entries(commands))
      scan.add({
        name: command,
        description: field(value, "description"),
        kind: "command",
        scope,
      });
  }
}

export async function discoverOpenCode(scan, { root, cwd }) {
  await addOpenCodeFolder(scan, root, { scope: "user", links: true });
  if (!cwd) return;
  // A project's opencode.json usually sits in the folder itself.
  await addConfigCommands(scan, cwd, "project");
  const project = path.join(cwd, ".opencode");
  if (!(await isLink(project)))
    await addOpenCodeFolder(scan, project, { scope: "project", links: false });
}
