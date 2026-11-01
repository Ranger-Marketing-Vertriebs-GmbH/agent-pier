import net from "node:net";

const ADDRESSES = ["127.0.0.1", "::1"];

function tcpConnect(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The loopback address a dev server listens on (IPv4 first), or null. */
export async function targetAddress(
  port,
  { timeoutMs = 1000, connect = tcpConnect } = {},
) {
  for (const host of ADDRESSES) if (await connect(port, host, timeoutMs)) return host;
  return null;
}

/** Ports a preview may never point at: AgentPier itself, the slot range, internal ports. */
export function forbiddenTarget(port, { hostPort, range, internal = new Set() } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return true;
  if (port === hostPort) return true;
  if (range && port >= range.start && port <= range.end) return true;
  return internal instanceof Set ? internal.has(port) : [...internal].includes(port);
}
