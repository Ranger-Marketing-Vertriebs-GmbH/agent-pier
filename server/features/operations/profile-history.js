import fs from "node:fs";
import path from "node:path";

// Claude Code keeps a project's transcripts in projects/<cwd with every character
// other than a letter or digit replaced by "-">.
export const claudeProjectFolder = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

function claudeRoots(stage) {
  const profiles = path.join(stage, "profiles"),
    roots = [];
  if (!fs.existsSync(profiles)) return roots;
  for (const account of fs.readdirSync(profiles)) {
    const base = path.join(profiles, account);
    roots.push(path.join(base, "claude"));
    const providers = path.join(base, "providers");
    if (fs.existsSync(providers))
      for (const provider of fs.readdirSync(providers))
        roots.push(path.join(providers, provider, "claude"));
  }
  return roots;
}

/**
 * Moves restored Claude Code transcripts of a remapped project to the folder of its
 * new directory, so the CLI finds them there. A folder that already exists for the
 * new directory is left alone.
 */
export function remapClaudeProjects(stage, mappings) {
  for (const root of claudeRoots(stage))
    for (const mapping of mappings) {
      if (!mapping.oldCwd || !mapping.cwd || mapping.oldCwd === mapping.cwd) continue;
      const from = path.join(root, "projects", claudeProjectFolder(mapping.oldCwd));
      const to = path.join(root, "projects", claudeProjectFolder(mapping.cwd));
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    }
}
