import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { problem } from "../../lib/storage.js";

// The safety checks every managed-tool unpacker shares (zip and tar.gz): names stay
// inside the top folder, links stay relative and inside it, and nothing is written
// through a link unpacked earlier.
const MAX_LINK = 4096;
const bad = (message) => problem(message, 409);

/** The entry's path below `dest` without a trailing slash; refuses unsafe names. */
export function entryName(name, top) {
  if (
    typeof name !== "string" ||
    name.length > 1024 ||
    /[\\\x00-\x1f\x7f]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((part) => part === "." || part === "..") ||
    !(name === `${top}/` || name.startsWith(`${top}/`))
  )
    throw bad(serverMessages.tools.unsafeArchivePath);
  return name.replace(/\/$/, "");
}

/**
 * Every parent below `dest` must be a real directory: a link unpacked earlier never
 * redirects a later entry. Missing parents are created.
 */
export async function realParents(dest, relative) {
  let current = dest;
  for (const part of path.posix.dirname(relative).split("/")) {
    if (part === ".") continue;
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch(() => null);
    if (!stat) await fsp.mkdir(current, { mode: 0o700 });
    else if (!stat.isDirectory() || stat.isSymbolicLink())
      throw bad(serverMessages.tools.unsafeArchivePath);
  }
}

/** A link at `relative` to `link` stays relative and inside the top folder. */
export function checkLink(relative, link, top) {
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relative), link || ""),
  );
  if (
    typeof link !== "string" ||
    !link ||
    link.length > MAX_LINK ||
    link.startsWith("/") ||
    /[\\\x00-\x1f]/.test(link) ||
    !(resolved === top || resolved.startsWith(`${top}/`))
  )
    throw bad(serverMessages.tools.unsafeArchivePath);
}

/**
 * Each link stays inside on its own; a chain of them may not. Once all are unpacked,
 * every link must resolve to a path inside the top folder.
 */
export function assertLinksInside(dest, top, links) {
  try {
    const inside = fs.realpathSync.native(path.join(dest, top));
    for (const link of links) {
      const real = fs.realpathSync.native(link);
      if (real !== inside && !real.startsWith(inside + path.sep))
        throw bad(serverMessages.tools.unsafeArchivePath);
    }
  } catch (cause) {
    throw cause?.status ? cause : bad(serverMessages.tools.unsafeArchivePath);
  }
}

/** The stored mode: executable or not, never setuid, setgid or writable for others. */
export const entryMode = (mode) => (mode & 0o111 ? 0o755 : 0o644);
