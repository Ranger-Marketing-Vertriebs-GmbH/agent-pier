import { writePrivate } from "../../lib/storage.js";

/** Atomic private write that never throws (diagnostics must not take the adapter down). */
export function writeDiagnostics(file, value) {
  try {
    writePrivate(file, value);
  } catch {
    /* a missing or read-only directory only loses diagnostics */
  }
}

/**
 * Throttled diagnostics file: `touch()` schedules a write at most once per `intervalMs`,
 * `flush()` writes at once (shutdown). The snapshot holds counters only; the file is
 * small, so the synchronous atomic write is fine. A null `path` disables the writer.
 */
export function createDiagnosticsWriter({
  path: file,
  intervalMs = 5000,
  snapshot,
  now = Date.now,
}) {
  let last = -Infinity;
  let timer = null;
  const write = () => {
    clearTimeout(timer);
    timer = null;
    last = now();
    writeDiagnostics(file, snapshot());
  };
  return {
    touch() {
      if (!file || timer) return;
      timer = setTimeout(write, Math.max(0, last + intervalMs - now()));
      timer.unref();
    },
    async flush() {
      if (file) write();
    },
  };
}
