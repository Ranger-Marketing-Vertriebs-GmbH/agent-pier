import fs from "node:fs/promises";

/**
 * The safety net behind the file watchers and the CLI's own pushes: while a chat has
 * viewers, stat the transcript files its reader last read (`sources()` returns
 * `{paths, readAt}`, ChatStore.sourceState) every `intervalMs` and report a change.
 * Only a change the last read cannot have seen counts, one whose modification time
 * is after that read started: a change a watcher or a push already caused a read
 * for is not reported again. Returns the stop function.
 */
export function probeChatSources({
  sources,
  changed,
  intervalMs = 1000,
  stat = (file) => fs.stat(file),
}) {
  const seen = new Map();
  let running = false,
    stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const state = sources();
      const paths = Array.isArray(state?.paths) ? state.paths : [];
      for (const file of seen.keys()) if (!paths.includes(file)) seen.delete(file);
      let fresh = false;
      for (const file of paths) {
        let info;
        try {
          info = await stat(file);
        } catch {
          // A file that is not there (yet) changes nothing; its creation will.
          seen.set(file, "missing");
          continue;
        }
        const signature = `${info.size}:${info.mtimeMs}`;
        const previous = seen.get(file);
        seen.set(file, signature);
        if (previous !== signature && info.mtimeMs > (state.readAt ?? Infinity))
          fresh = true;
      }
      if (fresh && !stopped) changed();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
