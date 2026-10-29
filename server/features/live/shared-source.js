// A change source that many live topic instances follow (one per user, agent or
// tab) through a single emitter listener.

/**
 * One change source shared by every instance that follows it: `follow(fanout)`
 * binds a single listener to its emitters while at least one instance watches, and
 * each event reaches every watching instance. Each user has her own instances, so
 * one emitter listener per instance would grow with users and tabs. Returns
 * `watch(listener)`, which returns the stop function.
 */
export function sharedSource(follow) {
  const listeners = new Set();
  let stop = null;
  const fanout = () => {
    for (const listener of [...listeners]) listener();
  };
  return (listener) => {
    const entry = () => listener();
    listeners.add(entry);
    if (!stop) stop = follow(fanout) || (() => {});
    return () => {
      if (!listeners.delete(entry) || listeners.size) return;
      const stopping = stop;
      stop = null;
      stopping();
    };
  };
}
