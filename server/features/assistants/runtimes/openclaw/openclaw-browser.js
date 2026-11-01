import { boundPort } from "./openclaw-agents.js";

/**
 * The browser sub-port (agent-runtime.js) over OpenClaw's browser control service:
 * `request` is one call of its HTTP API through `browser.request` (`/start`, `/stop`,
 * `/`, `/tabs`, `/screencast`, …, with the profile in `query`), answered with the
 * service's own body; `openStream` opens a screencast socket at the `wsPath` a
 * `/screencast` ticket names, pinned to the Gateway's own origin (gateway-client.js).
 */
export const openClawBrowser = (supervisor, clientOf) =>
  boundPort(browserOver, supervisor, clientOf);

function browserOver(current) {
  return {
    request: async ({ method, path, query, body, timeoutMs }) =>
      current().request(
        "browser.request",
        { method, path, query, ...(body ? { body } : {}) },
        ...(timeoutMs ? [{ timeoutMs }] : []),
      ),
    // Synchronous: the socket, or a throw for a path off the Gateway's origin.
    openStream: ({ path }) => current().openStream(path),
  };
}
