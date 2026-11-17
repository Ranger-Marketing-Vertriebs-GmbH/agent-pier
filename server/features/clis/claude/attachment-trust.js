// Claude Code asks at startup whether to trust a folder passed with --add-dir unless
// its profile records trust for it: `projects[<real path>].hasTrustDialogAccepted` in
// `.claude.json` (or that of a folder above it). AgentPier creates the chat attachment
// folder itself and keeps only the user's uploaded images there, so it records that
// trust for exactly this folder before the launch instead of stopping the session at
// a terminal dialog. When this does not happen, the dialog reaches the chat as a
// request (requests/claude-added-folder.js).
import fs from "node:fs";
import path from "node:path";
import { readConfig, record, updateConfig } from "../../extensions/mcp-config.js";

/**
 * Records Claude's folder trust for `directory` in the profile `env.CLAUDE_CONFIG_DIR`
 * names, keeping the entry's other fields. Only an AgentPier profile (an absolute
 * CLAUDE_CONFIG_DIR) is written; a local account's own `~/.claude.json` is left alone.
 * Returns whether the trust is recorded; never throws, so a launch never fails here.
 */
export function trustAttachmentFolder(env, directory) {
  const root = env?.CLAUDE_CONFIG_DIR;
  if (typeof root !== "string" || !path.isAbsolute(root)) return false;
  try {
    // Claude keys a folder outside a repository by its real path.
    const key = fs.realpathSync(directory);
    const config = readConfig(path.join(root, ".claude.json"), root, "claude");
    const projects = config.data.projects;
    if (projects !== undefined && !record(projects)) return false;
    const entry = projects?.[key];
    if (entry !== undefined && !record(entry)) return false;
    if (entry?.hasTrustDialogAccepted === true) return true;
    updateConfig(config, root, "claude", "projects", key, {
      ...entry,
      hasTrustDialogAccepted: true,
    });
    return true;
  } catch {
    return false;
  }
}
