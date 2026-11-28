import fs from "node:fs";
import path from "node:path";
import { readJSON } from "../../lib/storage.js";

/*
 * Reading a grants file of the devices (`agent-grants.json`, `session-grants.json`):
 * `{ version: 1, <key>: { "<id>": entry } }`.
 *
 * A file that cannot be read as that (cut off, hand-edited) grants nothing, and an
 * entry of another shape grants nothing either. Neither is lost silently: the next
 * change writes the file anew from what counts, so before that the file as it was
 * found is copied aside as `<file>.damaged-<time>` (for the owner only, never over
 * an earlier copy) and one line in the server log names the copy. The line never
 * holds anything the file said. Once the copy exists the file is written anew from
 * what counts (`rewrite`), so the next start finds a sound file and keeps no second
 * copy; a file that could not be copied stays as it was found. A missing file is no
 * damage.
 */
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// Copies `file` beside itself; returns the copy's name, or null when it cannot.
function keepAside(file, now) {
  for (let time = now(), tries = 0; tries < 1000; time++, tries++) {
    const target = `${file}.damaged-${time}`;
    try {
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      return path.basename(target);
    } catch (error) {
      if (error?.code !== "EEXIST") return null;
    }
  }
  return null;
}

/**
 * The entries of grants file `file` below `key`: a Map of id to `entry(id, value)`,
 * which returns the entry as it counts, or null (or throws) for one that does not.
 * `rewrite(entries)` writes the file anew after a damaged one was kept aside;
 * `now()` names the copy and `log(line)` hears of it (tests replace both).
 */
export function readGrants(
  file,
  key,
  entry,
  { rewrite = null, now = Date.now, log = console.warn } = {},
) {
  const entries = new Map();
  let stored = null;
  let damaged = false;
  try {
    stored = readJSON(file, undefined);
  } catch {
    damaged = true;
  }
  if (stored === undefined) return entries;
  const listed = plain(stored) && plain(stored[key]) ? stored[key] : null;
  if (!listed) damaged = true;
  let dropped = 0;
  for (const [id, value] of Object.entries(listed ?? {})) {
    let taken = null;
    try {
      taken = entry(id, value);
    } catch {
      // Counted below.
    }
    if (taken) entries.set(id, taken);
    else dropped++;
  }
  if (!damaged && !dropped) return entries;
  const what = damaged
    ? "cannot be read"
    : `holds ${dropped} ${dropped === 1 ? "entry" : "entries"} AgentPier cannot read`;
  const kept = keepAside(file, now);
  if (kept)
    try {
      rewrite?.(entries);
    } catch {
      // The file stays as it was found; its copy exists.
    }
  try {
    log(
      `Android devices: ${path.basename(file)} ${what}; what it assigned there counts for nothing. ${
        kept
          ? `The file as it was is kept as ${kept}.`
          : "The file could not be kept aside; the next change of an assignment replaces it."
      }`,
    );
  } catch {
    // A log that fails loses a line, nothing else.
  }
  return entries;
}
