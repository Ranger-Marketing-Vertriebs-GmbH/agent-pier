import fs from "node:fs";
import path from "node:path";

// A skill OpenClaw finds in the agent's workspace, its `.agents` folder or the
// Gateway's managed and personal folders wins over a bundled skill of the same name
// (docs/assistant-gateway.md#skills). Shell commands run as the owner and can write
// such a folder, so an owner's switch for a bundled skill must never load it: the
// compiler drops every assigned name found there. The scan over-approximates
// OpenClaw's discovery (any SKILL.md up to a few levels deep, by folder name and
// frontmatter name), which only ever drops more.

const maxDepth = 4;
const maxEntries = 2000;

/** The folders whose skills take precedence over bundled ones for this agent. */
export function skillShadowRoots(root, assistantId) {
  const workspace = path.join(root, "workspaces", assistantId);
  return [
    path.join(workspace, "skills"),
    path.join(workspace, ".agents", "skills"),
    path.join(root, "state", "skills"),
    path.join(root, "home", ".agents", "skills"),
    path.join(root, "home", ".openclaw", "skills"),
  ];
}

function frontmatterName(file) {
  let text = "";
  try {
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(8192);
      text = buffer.subarray(0, fs.readSync(handle, buffer, 0, 8192, 0)).toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return "";
  }
  const block = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || "";
  return /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(block)?.[1]?.trim() || "";
}

/** Every skill name found below the given folders (lowercased folder names, too). */
export function shadowingSkillNames(roots) {
  const names = new Set();
  let budget = maxEntries;
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (--budget < 0) return;
      const full = path.join(dir, entry.name);
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink())
        try {
          directory = fs.statSync(full).isDirectory();
        } catch {
          directory = false;
        }
      if (!directory) continue;
      const skillFile = path.join(full, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        names.add(entry.name.toLowerCase());
        const name = frontmatterName(skillFile);
        if (name) names.add(name);
      }
      visit(full, depth + 1);
    }
  };
  for (const root of roots) visit(root, 1);
  return names;
}

/** The assigned names a higher-precedence skill of this agent would replace. */
export const shadowedSkills = (root, assistant, names) => {
  if (!names.length || !root) return [];
  const found = shadowingSkillNames(skillShadowRoots(root, assistant.id));
  return names.filter((name) => found.has(name));
};
