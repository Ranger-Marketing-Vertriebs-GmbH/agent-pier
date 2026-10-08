// Protocol adapter for one session. terminal-launcher.js starts it and sends the private
// configuration over IPC; the key never appears in argv or env. It never writes to
// stdout/stderr (the launcher's stdio is the CLI's terminal).
import { validateAdapterConfig } from "./features/adapter-runtime/adapter-config.js";
import { createAdapterServer } from "./features/adapter-runtime/adapter-server.js";

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
process.once("message", async (message) => {
  let config;
  try {
    if (message?.type !== "start") throw new TypeError("adapter: unexpected message");
    config = validateAdapterConfig(message.config);
  } catch {
    return fail("config", 78);
  }
  try {
    // Restarts rebind the original port so the CLI's substituted URL stays valid.
    const wanted =
      Number.isInteger(message.port) && message.port > 0 && message.port < 65536
        ? message.port
        : 0;
    server = createAdapterServer(config, {
      restarts: Number.isInteger(message.restarts) ? message.restarts : 0,
    });
    const port = await server.listen(wanted);
    process.send({ type: "ready", port });
  } catch {
    fail("bind", 71);
  }
});
