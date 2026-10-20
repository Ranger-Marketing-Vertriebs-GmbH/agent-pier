import fs from "node:fs/promises";

/**
 * The safety net behind the file watchers and the CLI's own pushes: while a chat has
 * viewers, stat the transcript files its reader last read (`sources()` returns
 * `{paths, readAt}`, ChatStore.sourceState) every `intervalMs` and report a change.
 * Ordinary writes already covered by a newer read are not reported again. File
 * identity and disappearance also count: replacements may preserve modification
 * times. Maintenance repairs missing/failed OS watches without restarting others.
 */
export function probeChatSources({
  sources,
  changed,
  intervalMs = 1000,
  stat = (file) => fs.stat(file),
  maintain = () => {},
  discover = () => false,
}) {
  const seen = new Map();
  let running = false,
    stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await maintain();
      if (stopped) return;
      const state = sources();
      const paths = Array.isArray(state?.paths) ? state.paths : [];
      for (const file of seen.keys()) if (!paths.includes(file)) seen.delete(file);
      let fresh = !paths.length && discover();
      for (const file of paths) {
        let info;
        try {
          info = await stat(file);
        } catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes(error.code)) continue;
          const previous = seen.get(file);
          if (previous && !previous.missing) fresh = true;
          if (!previous?.missing) seen.set(file, { missing: true, readAt: state.readAt });
          continue;
        }
        const identity = `${info.dev}:${info.ino}`;
        const signature = `${identity}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const previous = seen.get(file);
        seen.set(file, { signature, identity });
        if (
          (previous?.missing && previous.readAt === state.readAt) ||
          (previous && !previous.missing && previous.identity !== identity) ||
          (previous?.signature !== signature &&
            Math.max(info.mtimeMs, info.ctimeMs || 0) > (state.readAt ?? Infinity))
        )
          fresh = true;
      }
      if (fresh && !stopped) changed();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick().catch(() => {}), intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
