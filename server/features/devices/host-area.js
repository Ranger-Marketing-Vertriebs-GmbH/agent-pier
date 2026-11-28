import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { assertOutsideDirs, protectedDirs } from "../assistants/protected-dirs.js";
import { FileNative, nativeReadBytes } from "../files/file-native.js";
import { folderIdentity } from "../memory/project-rebind.js";
import { refusal } from "./device-registry.js";

/*
 * Files that travel between a device and the host stay inside the caller's own
 * area on the host: a session's working folder, an agent's workspace. A caller in a
 * sandbox could otherwise make the server, which is in none, read or write for it.
 *
 * An area is one folder, not a path: `{ path, dev, ino }`, its real path and its
 * device and inode numbers as they were when the caller got the folder (`areaOf`;
 * for a session, when its CLI was started: session-creation.js). A caller that can
 * write the folder above its own could otherwise move its folder away and put a
 * link, or another folder, in its place. So before anything else the folder at that
 * path must still be that very folder (DEVICE_PATH_OUTSIDE otherwise), and the
 * folder that is then opened is checked for the same numbers once more.
 *
 * The rule, for a host path a caller names (absolute, or relative to the area):
 *
 * 1. The server resolves the real path, every symbolic link followed: of the file
 *    to read, or of the folder to write into. A link inside the area that leads to
 *    another place inside it is fine; a real path outside is DEVICE_PATH_OUTSIDE.
 *    So is a path in or below AgentPier's own data folder (`protectedRoots`).
 * 2. The file is then opened from the area's root, one name after another, without
 *    following any link (FileNative, openat with O_NOFOLLOW). What is read or
 *    written is therefore the file that was checked: a name on the way that was
 *    swapped for a link in between fails instead of leading out.
 * 3. Only a regular file with one name is read. A file is written under a
 *    temporary name beside its place and renamed onto it; an existing regular file
 *    is replaced, and a link or folder with that name is refused, never followed.
 *
 * adb never sees a path of the area: it reads and writes a private copy below the
 * server's own data folder (`copyIn`, `copyOut`).
 */
const outside = () => refusal("DEVICE_PATH_OUTSIDE", 403);
/** What a caller reads when its area is no longer the folder it was given. */
export const AREA_CHANGED =
  "The working folder is no longer the folder this session was started in: it was moved or replaced. Put it back, or reload the session.";
/** What a caller reads when nothing recorded which folder it was given. */
export const AREA_UNKNOWN =
  "AgentPier has no record of the folder this session was started in. Reload the session.";
const changed = () => refusal("DEVICE_PATH_OUTSIDE", 403, { detail: AREA_CHANGED });
const missing = () => refusal("DEVICE_FILE_NOT_FOUND", 404);
const tooLarge = (limit) => refusal("DEVICE_FILE_TOO_LARGE", 400, { limit });
const within = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
// What FileNative reports as one of this module's refusals.
function translate(error) {
  if (/^DEVICE_/.test(error?.code || "")) return error;
  return error?.code === "FILE_NOT_FOUND" ? missing() : outside();
}
function real(target) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    throw ["ENOENT", "ENOTDIR"].includes(error.code) ? missing() : outside();
  }
}

/** The area that the folder at `folder` is now: `{ path, dev, ino }`. Throws without one. */
export const areaOf = (folder) => folderIdentity(folder);

// The real path of `area` while the folder there is still the one it names.
function rootOf(area) {
  if (
    !area ||
    typeof area !== "object" ||
    typeof area.path !== "string" ||
    !path.isAbsolute(area.path) ||
    typeof area.dev !== "string" ||
    typeof area.ino !== "string"
  )
    throw outside();
  let now;
  try {
    now = folderIdentity(area.path);
  } catch {
    throw changed();
  }
  if (now.path !== area.path || now.dev !== area.dev || now.ino !== area.ino)
    throw changed();
  return now.path;
}

/**
 * Where `requested` lies in `area`: `{ root, folder, name, area }` with the real root
 * of the area, the folder's path relative to it (`""` for the root itself) and the
 * file's name. `parent: true` resolves only the folder, for a file to be written.
 * Throws DEVICE_PATH_OUTSIDE also when the area's folder was moved or replaced.
 */
export function locate(area, requested, { parent = false, protectedRoots = [] } = {}) {
  if (
    typeof requested !== "string" ||
    !requested ||
    requested.includes("\0") ||
    requested.length > 4096
  )
    throw outside();
  const root = rootOf(area);
  const absolute = path.resolve(root, requested);
  const name = path.basename(absolute);
  if (!name || absolute === path.parse(absolute).root) throw outside();
  const folder = parent ? real(path.dirname(absolute)) : path.dirname(real(absolute));
  const target = parent ? path.join(folder, name) : real(absolute);
  if (!within(root, target) || target === root) throw outside();
  const dirs = protectedDirs(protectedRoots, outside);
  assertOutsideDirs(root, dirs, outside);
  assertOutsideDirs(folder, dirs, outside);
  return {
    root,
    folder: path.relative(root, folder).split(path.sep).join("/"),
    // The name as the real path spells it (the link's target, when it was one).
    name: path.basename(target),
    area,
  };
}

/**
 * Where a file `requested` would be written in `area` (`locate` of its folder).
 * Throws DEVICE_PATH_OUTSIDE when a link or a folder has that name already: it is
 * never followed or replaced. `copyOut` checks the same again when it writes.
 */
export function destination(area, requested, { protectedRoots = [] } = {}) {
  const place = locate(area, requested, { parent: true, protectedRoots });
  let existing = null;
  try {
    existing = fs.lstatSync(path.join(place.root, place.folder, place.name));
  } catch (error) {
    if (error.code !== "ENOENT") throw outside();
  }
  if (existing && !existing.isFile()) throw outside();
  return place;
}

async function opened(native, place) {
  const root = await native.run("openRoot", { path: place.root });
  // The folder that was opened, not the one a path named a moment ago.
  const found = await native.run("stat", { handle: root.handle });
  if (String(found.dev) !== place.area.dev || String(found.ino) !== place.area.ino)
    throw changed();
  return native.run("openLookup", { directory: root.handle, path: place.folder });
}

/**
 * Copies the file `requested` of `area` to the new private file `target`, at most
 * `maxBytes`. Resolves `{ bytes, name }`. Throws DEVICE_PATH_OUTSIDE,
 * DEVICE_FILE_NOT_FOUND or DEVICE_FILE_TOO_LARGE; `target` does not exist then.
 */
export async function copyIn({ area, requested, target, maxBytes, protectedRoots }) {
  const place = locate(area, requested, { protectedRoots });
  const native = new FileNative();
  let output = null;
  try {
    const folder = await opened(native, place);
    const info = await native.run("inspect", {
      directory: folder.handle,
      name: place.name,
    });
    if (info.type === "directory") throw missing();
    // A second name may be a hard link to a file outside the area.
    if (info.type !== "file" || info.nlink !== 1n) throw outside();
    if (info.size > BigInt(maxBytes)) throw tooLarge(maxBytes);
    const file = await native.run("openFile", {
      directory: folder.handle,
      path: place.name,
    });
    const before = await native.run("stat", { handle: file.handle });
    if (before.ino !== info.ino || before.dev !== info.dev || before.nlink !== 1n)
      throw outside();
    output = fs.openSync(target, "wx", 0o600);
    let bytes = 0;
    for (;;) {
      const chunk = await native.run("read", {
        handle: file.handle,
        length: nativeReadBytes,
        position: bytes,
      });
      if (!chunk.length) break;
      bytes += chunk.length;
      if (bytes > maxBytes) throw tooLarge(maxBytes);
      fs.writeSync(output, chunk);
    }
    return { bytes, name: place.name };
  } catch (error) {
    if (output !== null) {
      fs.closeSync(output);
      output = null;
      fs.rmSync(target, { force: true });
    }
    throw translate(error);
  } finally {
    if (output !== null) fs.closeSync(output);
    await native.close();
  }
}

/**
 * Writes the private file `source` (at most `maxBytes`) to `requested` in `area`,
 * replacing a regular file of that name. Resolves `{ bytes, name }`. Throws
 * DEVICE_PATH_OUTSIDE (also for a link or folder in its place),
 * DEVICE_FILE_NOT_FOUND (its folder does not exist) or DEVICE_FILE_TOO_LARGE. Once
 * `signal` has aborted nothing is written any more (DEVICE_ADB_CANCELLED): the file
 * that was there stays as it was.
 */
export async function copyOut({
  area,
  requested,
  source,
  maxBytes,
  protectedRoots,
  signal,
}) {
  // Asked before every step up to the last one, the rename onto the file's name.
  const ended = () => {
    if (signal?.aborted) throw refusal("DEVICE_ADB_CANCELLED");
  };
  ended();
  const place = destination(area, requested, { protectedRoots });
  let stat = null;
  try {
    stat = fs.lstatSync(source);
  } catch {
    // Nothing arrived.
  }
  if (!stat?.isFile()) throw missing();
  if (stat.size > maxBytes) throw tooLarge(maxBytes);
  const native = new FileNative();
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const temporary = `.agentpier-device-${randomBytes(8).toString("hex")}.part`;
  let created = null;
  let folder = null;
  try {
    folder = await opened(native, place);
    let existing = null;
    try {
      existing = await native.run("inspect", {
        directory: folder.handle,
        name: place.name,
      });
    } catch (error) {
      if (error?.code !== "FILE_NOT_FOUND") throw error;
    }
    if (existing && existing.type !== "file") throw outside();
    created = await native.run("createFile", {
      directory: folder.handle,
      name: temporary,
    });
    const buffer = Buffer.alloc(nativeReadBytes);
    let bytes = 0;
    for (;;) {
      ended();
      const read = fs.readSync(input, buffer, 0, buffer.length, bytes);
      if (!read) break;
      if (bytes + read > maxBytes) throw tooLarge(maxBytes);
      for (let offset = 0; offset < read;) {
        offset += await native.run("write", {
          handle: created.handle,
          bytes: buffer.subarray(offset, read),
          position: bytes + offset,
        });
      }
      bytes += read;
    }
    await native.run("sync", { handle: created.handle });
    ended();
    if (existing)
      await native.run("removeEntry", {
        directory: folder.handle,
        name: place.name,
        identity: `${existing.dev}:${existing.ino}`,
        type: "file",
      });
    await native.run("renameNoReplace", {
      oldParent: folder.handle,
      oldName: temporary,
      newParent: folder.handle,
      newName: place.name,
    });
    created = null;
    return { bytes, name: place.name };
  } catch (error) {
    throw translate(error);
  } finally {
    fs.closeSync(input);
    if (created && folder)
      await native
        .run("removeEntry", {
          directory: folder.handle,
          name: temporary,
          identity: `${created.dev}:${created.ino}`,
          type: "file",
        })
        .catch(() => {});
    await native.close();
  }
}
