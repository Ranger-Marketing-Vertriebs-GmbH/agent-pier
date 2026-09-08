const timers = new WeakMap();
/** The live keeper prevents PID reuse until the last signal has been sent. */
export function stopOwnedGroup(child) {
  if (
    !child?.pid ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    timers.has(child)
  )
    return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }, 1000);
  timers.set(child, timer);
  child.once("close", () => {
    clearTimeout(timer);
    timers.delete(child);
  });
}
