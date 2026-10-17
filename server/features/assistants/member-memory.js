import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// The files OpenClaw indexes as memory: the two root notes and Markdown notes
// under memory/ (native-memory.js), with the same depth, count and size bounds.
const rootNotes = ["MEMORY.md", "USER.md"];
const noteName = /^memory\/(?:[A-Za-z0-9][\w.-]*\/){0,3}[A-Za-z0-9][\w.-]*\.md$/;
const maxNotes = 200,
  maxNoteBytes = 262144;

async function realDirectory(dir) {
  try {
    return (await fs.lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// One regular file, never through a link, within the size bound; null otherwise.
async function readNote(root, name) {
  let handle;
  try {
    handle = await fs.open(
      path.join(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxNoteBytes) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** The memory notes below `root` by relative name; symbolic links are skipped. */
async function listNotes(root) {
  const names = [];
  if (!(await realDirectory(root))) return names;
  for (const name of rootNotes) {
    try {
      if ((await fs.lstat(path.join(root, name))).isFile()) names.push(name);
    } catch {
      /* Not there. */
    }
  }
  if (!(await realDirectory(path.join(root, "memory")))) return names;
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (names.length >= maxNotes + rootNotes.length) return;
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory() && depth < 3) await walk(name, depth + 1);
      else if (entry.isFile() && noteName.test(name)) names.push(name);
    }
  };
  await walk("memory", 0);
  return names;
}

/**
 * Keeps a temporary member's memory a read-only copy of its lead's: before each of
 * the member's turns its MEMORY.md, USER.md and memory/ notes are replaced by the
 * lead's current ones, and removed once the member no longer holds memory
 * (`enabled` false). The member has no write or edit tool, and the copy is
 * rewritten every turn, so nothing a member does reaches the lead's memory. A
 * workspace that does not exist yet (the member was never created) is left alone.
 */
export async function mirrorLeadMemory(workspaces, member, enabled) {
  if (!workspaces || !member?.parentAssistantId) return;
  const own = path.join(workspaces, member.id),
    lead = path.join(workspaces, member.parentAssistantId);
  if (!(await realDirectory(own))) return;
  const wanted = new Map();
  if (enabled)
    for (const name of await listNotes(lead)) {
      const content = await readNote(lead, name);
      if (content !== null) wanted.set(name, content);
    }
  for (const name of await listNotes(own))
    if (!wanted.has(name)) await fs.rm(path.join(own, name), { force: true });
  for (const [name, content] of wanted) {
    if ((await readNote(own, name)) === content) continue;
    const dir = path.dirname(path.join(own, name));
    // Every folder on the way must be a real directory inside the member's workspace.
    await fs.mkdir(dir, { recursive: true });
    const real = await fs.realpath(dir);
    if (real !== path.join(await fs.realpath(own), path.dirname(name))) continue;
    const target = path.join(real, path.basename(name));
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, target);
  }
}
