import fs from "node:fs";
import path from "node:path";
import { isMap, parseDocument } from "yaml";

// A skill OpenClaw finds in the agent's workspace, its `.agents` folder or the
// Gateway's managed and personal folders wins over a bundled skill of the same name
// (docs/assistant-gateway.md#skills). Shell commands run as the owner and can write
// such a folder, so an owner's switch for a bundled skill must never load it: the
// compiler drops every assigned name found there. The scan over-approximates
// OpenClaw's discovery (any SKILL.md up to 8 levels deep, by folder name and YAML
// frontmatter name), and fails closed: a file it cannot read shadows every name.

// Deeper than OpenClaw looks (MAX_GROUPED_SKILL_SCAN_DEPTH 6 below a root).
const maxDepth = 8;
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

// Read like OpenClaw reads it (frontmatter-*.mjs): the block between the opening
// and closing `---`, parsed as YAML with the core schema. `undefined` means "no
// name" (the folder name counts); `anyName` means the file could carry any name:
// unreadable, unparsable, too long or a name that is not a plain string.
export const anyName = Symbol("any skill name");
const maxRead = 65536;
const opening = /^---[^\S\n]*\n/;
const closing = /(?:^|\n)---[^\S\n]*(?:\n|(?![\s\S]))/;

export function frontmatterName(content, truncated = false) {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const open = opening.exec(text);
  if (!open) return truncated && text.startsWith("---") ? anyName : undefined;
  const tail = text.slice(open[0].length);
  const close = closing.exec(tail);
  if (!close) return truncated ? anyName : undefined;
  const block = tail.slice(0, close.index);
  if (!block.trim()) return undefined;
  let document;
  try {
    document = parseDocument(block, {
      schema: "core",
      prettyErrors: false,
    });
  } catch {
    return anyName;
  }
  if (document.errors.length || !isMap(document.contents)) return anyName;
  const value = document.toJS();
  if (!value || typeof value !== "object" || !("name" in value)) return undefined;
  return typeof value.name === "string" && value.name.trim()
    ? value.name.trim()
    : anyName;
}

function fileName(file) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(maxRead + 1);
    const read = fs.readSync(handle, buffer, 0, maxRead + 1, 0);
    return frontmatterName(
      buffer.subarray(0, Math.min(read, maxRead)).toString("utf8"),
      read > maxRead,
    );
  } catch {
    return anyName;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/**
 * Every skill name found below the given folders (lowercased folder names, too);
 * `anyName` when a file could carry any name, or the scan hit its limit.
 */
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
      if (--budget < 0) {
        names.add(anyName);
        return;
      }
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
        const name = fileName(skillFile);
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
  return names.filter((name) => found.has(anyName) || found.has(name));
};
