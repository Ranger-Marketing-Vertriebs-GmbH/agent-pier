import { readFileSync, rmSync } from "node:fs";
import { writePrivate } from "../../lib/storage.js";

/** The session record next to `<id>.adapter.json`. */
export const sessionRecordPath = (file) => file.replace(/\.adapter\.json$/, ".json");

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Whether `generation` may write `file`: the session record must exist and name it as its
 * current adapter generation. A removed session (no record) or a reloaded one (a newer
 * generation) refuses the late final write of an adapter that is still shutting down. A
 * null generation (tests, direct use) is not guarded.
 */
export function ownsDiagnostics(file, generation) {
  if (generation === null || generation === undefined) return true;
  return readJson(sessionRecordPath(file))?.adapterGeneration === generation;
}

/** This generation's last snapshot (a crash restart continues its counters), else null. */
export function readOwnSnapshot(file, generation) {
  if (!file) return null;
  const snapshot = readJson(file);
  return snapshot?.version === 1 && snapshot.generation === (generation ?? null)
    ? snapshot
    : null;
}

/**
 * Atomic private write that never throws (diagnostics must not take the adapter down);
 * returns whether the snapshot was kept. Removal deletes the session record before the
 * diagnostics file and reload records the new generation before deleting it, so a write
 * that passed the first check but lost the race is noticed by the second one and taken
 * back (only while the file still holds this generation's snapshot).
 */
export function writeDiagnostics(file, value, generation = null) {
  if (!ownsDiagnostics(file, generation)) return false;
  try {
    writePrivate(file, value);
  } catch {
    return false; // a missing or read-only directory only loses diagnostics
  }
  if (ownsDiagnostics(file, generation)) return true;
  try {
    if (readJson(file)?.generation === generation) rmSync(file, { force: true });
  } catch {}
  return false;
}

/**
 * Throttled diagnostics file: `touch()` schedules a write at most once per `intervalMs`,
 * `flush()` writes at once and closes the writer (shutdown): later touches are ignored. A
 * writer that was never touched writes nothing on flush, so an adapter that served nothing
 * leaves the file alone (or absent). The snapshot holds counters only; the file is small,
 * so the synchronous atomic write is fine. A null `path` disables the writer; `generation`
 * guards every write (see `writeDiagnostics`).
 */
export function createDiagnosticsWriter({
  path: file,
  generation = null,
  intervalMs = 5000,
  snapshot,
  now = Date.now,
}) {
  let last = -Infinity;
  let timer = null;
  let closed = false;
  let touched = false;
  const write = () => {
    clearTimeout(timer);
    timer = null;
    last = now();
    writeDiagnostics(file, snapshot(), generation);
  };
  return {
    touch() {
      if (!file || closed) return;
      touched = true;
      if (timer) return;
      timer = setTimeout(write, Math.max(0, last + intervalMs - now()));
      timer.unref();
    },
    async flush() {
      if (!file || closed) return;
      closed = true;
      if (touched) write();
    },
  };
}
