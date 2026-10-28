// The browser behind LiveClient: tests pass their own fake of the same shape.
// Timer functions are wrapped so calling them as a method of the environment does
// not throw "Illegal invocation".
export function liveEnvironment() {
  const { location } = globalThis;
  return {
    WebSocket: globalThis.WebSocket,
    url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/live`,
    document: globalThis.document,
    window: globalThis.window,
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    random: () => Math.random(),
    now: () => Date.now(),
  };
}
