import { scripts as messages } from "./i18n/de/scripts.js";

export const DEFAULT_BACKEND_PORT = 4380;
export const DEFAULT_VITE_PORT = 5173;

// Digits only: Number() would also accept " 4380", "0x111c" or "1e3".
function integer(value) {
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

/**
 * The ports of `npm run dev`, shared by vite.config.js (Vite port and proxy target) and
 * the backend (its dev origin allowlist), so both always agree. Without configuration
 * Vite listens on 5173 and proxies to 4380. A pipeline stage that leased a port block
 * (AGENTPIER_PORT, AGENTPIER_PORT_COUNT >= 2) runs the backend on the block's first port
 * and Vite on its second, so parallel stages never collide. Invalid values throw.
 */
export function devPorts(env = process.env) {
  const configured = env.AGENTPIER_PORT || env.TUIUI_PORT;
  const backend = configured ? integer(configured) : DEFAULT_BACKEND_PORT;
  if (!Number.isInteger(backend) || backend < 1024 || backend > 65535)
    throw new Error(messages.invalidServerPort);
  if (!env.AGENTPIER_PORT_COUNT) return { backend, vite: DEFAULT_VITE_PORT };
  if (!configured) throw new Error(messages.portCountWithoutPort);
  const count = integer(env.AGENTPIER_PORT_COUNT);
  if (!Number.isInteger(count) || count < 1) throw new Error(messages.invalidPortCount);
  if (count < 2) throw new Error(messages.devPortBlockTooSmall(count));
  const vite = backend + 1;
  if (vite > 65535) throw new Error(messages.devPortOutOfRange(vite));
  return { backend, vite };
}

/** The one origin the dev server is reached at, in its two loopback spellings. */
export function devOrigins(env = process.env) {
  const { vite } = devPorts(env);
  return [`http://127.0.0.1:${vite}`, `http://localhost:${vite}`];
}
