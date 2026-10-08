// Protocol adapter for one session. terminal-launcher.js starts it and sends the private
// configuration over IPC; the key never appears in argv or env. It never binds a port:
// the supervisor owns the loopback listener (so the port stays reserved across restarts)
// and hands every accepted connection over IPC. It never writes to stdout/stderr (the
// launcher's stdio is the CLI's terminal).
//
// No static imports: the IPC channel delivers messages as soon as it reads them, and a
// message that arrives before a listener exists is lost. The start listener is therefore
// registered first and the adapter modules are loaded inside it.

for (const signal of ["SIGINT", "SIGQUIT", "SIGHUP"]) process.on(signal, () => {});
let server = null;
let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(code), 1500);
  try {
    await server?.close();
  } catch {}
  clearTimeout(force);
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("disconnect", () => shutdown(0));
process.on("uncaughtException", () => shutdown(70));
process.on("unhandledRejection", () => shutdown(70));
/** Reports a start failure, then exits — only after the IPC message is flushed (≤ 500 ms). */
function fail(reason, code) {
  const exit = () => {
    clearTimeout(fallback);
    shutdown(code);
  };
  const fallback = setTimeout(exit, 500);
  try {
    process.send({ type: "failed", reason }, exit);
  } catch {
    exit();
  }
}
const validPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;

process.once("message", async (message) => {
  let config;
  try {
    const [{ validateAdapterConfig }, { createAdapterServer }] = await Promise.all([
      import("./features/adapter-runtime/adapter-config.js"),
      import("./features/adapter-runtime/adapter-server.js"),
    ]);
    if (message?.type !== "start") throw new TypeError("adapter: unexpected message");
    if (!validPort(message.port)) throw new TypeError("adapter: invalid port");
    config = validateAdapterConfig(message.config);
    // Throws synchronously only for a refused IP-literal upstream: a configuration error.
    server = createAdapterServer(config, {
      restarts: Number.isInteger(message.restarts) ? message.restarts : 0,
    });
  } catch {
    return fail("config", 78);
  }
  server.attach(message.port);
  process.on("message", (next, socket) => {
    if (next?.type === "connection" && socket) server.accept(socket);
  });
  process.send({ type: "ready", port: message.port });
});
