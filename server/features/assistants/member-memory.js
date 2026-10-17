import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

// Where a member keeps the copy of its lead's memory: one flat folder under its own
// memory/, so memory search finds it, apart from the member's own notes, and the
// write guard refuses every write into it (ownMemoryTarget, lead-request-writes.js).
export const leadMirrorDir = "memory/lead";
/** The mirror file of one of the lead's memory files (notes flattened, prefixed). */
// Flattened collision-free: "~" escapes itself ("~~") and every "/" ("~s"), and
// neither occurs in a note name otherwise (noteName allows letters, digits, _ . -).
export const mirrorName = (name) =>
  rootNotes.includes(name)
    ? `${leadMirrorDir}/${name}`
    : `${leadMirrorDir}/note-${name
        .slice("memory/".length)
        .replaceAll("~", "~~")
        .replaceAll("/", "~s")}`;

// Whether `dir` (below `own`) is a real directory that resolves where it should.
async function inside(own, dir) {
  try {
    const real = await fs.realpath(path.join(own, dir));
    return (
      (await realDirectory(path.join(own, dir))) &&
      real === path.join(await fs.realpath(own), dir)
    );
  } catch {
    return false;
  }
}

/**
 * Keeps the copy of the lead's memory in a temporary member's workspace current:
 * before each of the member's turns `memory/lead/` holds the lead's MEMORY.md,
 * USER.md and memory/ notes as they are now, and nothing else; it is emptied once
 * the member no longer holds the lead's memory (`enabled` false) and on promotion.
 * The member's own memory (its MEMORY.md and the rest of memory/) is never touched.
 * Copies from before this layout (the member's own root files identical to the
 * lead's) are removed once, when the folder is first created. A workspace that does
 * not exist yet (the member was never created) is left alone.
 */
export async function mirrorLeadMemory(workspaces, member, enabled) {
  if (!workspaces || !member?.parentAssistantId) return;
  const own = path.join(workspaces, member.id),
    lead = path.join(workspaces, member.parentAssistantId);
  if (!(await realDirectory(own))) return;
  const wanted = new Map(),
    legacy = new Map();
  if (enabled)
    for (const name of await listNotes(lead)) {
      const content = await readNote(lead, name);
      if (content === null) continue;
      wanted.set(mirrorName(name), content);
      legacy.set(name, content);
    }
  const existed = await realDirectory(path.join(own, leadMirrorDir));
  if (existed && (await inside(own, leadMirrorDir)))
    for (const entry of await fs.readdir(path.join(own, leadMirrorDir))) {
      const name = `${leadMirrorDir}/${entry}`;
      if (wanted.has(name)) continue;
      // The folder is flat: only files and links in it are removed, a planted
      // folder is left alone and never walked.
      const stat = await fs.lstat(path.join(own, name)).catch(() => null);
      if (stat && !stat.isDirectory())
        await fs.unlink(path.join(own, name)).catch(() => {});
    }
  if (!wanted.size) return;
  if (!(await realDirectory(path.join(own, "memory"))))
    await fs.mkdir(path.join(own, "memory"), { recursive: true }).catch(() => {});
  await fs.mkdir(path.join(own, leadMirrorDir), { recursive: true }).catch(() => {});
  // Every folder on the way must be a real directory inside the member's workspace.
  if (!(await inside(own, "memory")) || !(await inside(own, leadMirrorDir))) return;
  if (!existed)
    for (const [name, content] of legacy)
      if ((await readNote(own, name)) === content)
        await fs.rm(path.join(own, name), { force: true });
  const real = path.join(await fs.realpath(own), leadMirrorDir);
  for (const [name, content] of wanted) {
    if ((await readNote(own, name)) === content) continue;
    const target = path.join(real, path.basename(name));
    // A fresh name that must not exist yet ("wx", O_EXCL), so nothing planted under
    // it is followed or overwritten; a link in the target's place is removed first,
    // so the rename replaces the link itself and never writes through it.
    const temporary = path.join(real, `.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    try {
      if ((await fs.lstat(target)).isSymbolicLink()) await fs.unlink(target);
    } catch {
      /* No target yet. */
    }
    await fs.rename(temporary, target);
  }
}
