import { sessionToken } from "../../http/login.js";
import { principalOf } from "../users/identity.js";
import { allowedNetworkHosts } from "../remote/network-access.js";
import { listenerPort } from "./preview-slots.js";
import { fromTailnetMember } from "../../http/tailscale-request.js";

const loopbacks = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const noNetwork = { addresses: [], hostname: "" };

/** A refusal the listener answers with a page (or a plain status for sub-requests). */
export const refusal = (status, page, extra = {}) =>
  Object.assign(new Error(page), { status, page, ...extra });

/** The current config from `effective`: a function (the app's effective()) or an object. */
export const previewConfig = (effective) =>
  (typeof effective === "function" ? effective() : effective) || {};

/**
 * The trust branch of a preview request, by the same rules as AgentPier's own
 * `authorizeRequest`, with the slot port in place of AgentPier's: throws a 403 refusal.
 * Loopback names the listener's own `port`; Tailscale and the network name the slot.
 */
export function previewBranch(
  req,
  { slot, port = listenerPort(slot), effective, detected = noNetwork },
) {
  const current = previewConfig(effective);
  const host = req.headers.host;
  const loopback = loopbacks.includes(req.socket?.remoteAddress);
  const names = Object.keys(req.headers);
  const tailscaleMarkers = names.some((key) => key.startsWith("tailscale-"));
  const proxyMarkers =
    tailscaleMarkers ||
    names.some((key) => key.startsWith("x-forwarded-") || key === "forwarded");
  if (loopback && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
    // Tailscale Serve keeps the Host header: proxy markers never enter the local branch.
    if (proxyMarkers) throw refusal(403, "forbidden");
    return "local";
  }
  if (
    loopback &&
    current.remoteUrl &&
    `${new URL(current.remoteUrl).hostname}:${slot}` === host
  ) {
    // Funnel and tagged devices carry no identity and stay refused.
    if (!fromTailnetMember(req.headers)) throw refusal(403, "forbidden");
    return "tailscale";
  }
  const network = current.network;
  if (network?.enabled && allowedNetworkHosts(network, slot, detected).has(host)) {
    if (tailscaleMarkers) throw refusal(403, "forbidden");
    return "network";
  }
  throw refusal(403, "forbidden");
}

/**
 * Where the owner signs in to AgentPier and comes back: AgentPier's origin under the
 * host name the browser used for the preview (its cookie is then the one it sends here).
 */
export function signInUrl(branch, req, { effective, slot, path = "/" }) {
  const current = previewConfig(effective);
  const origin =
    branch === "tailscale"
      ? new URL(current.remoteUrl).origin
      : `http://${new URL(`http://${req.headers.host}`).hostname}:${current.port}`;
  return `${origin}/?preview=${slot}&path=${encodeURIComponent(path)}`;
}

/**
 * The gate of one slot: the host branch, then an owner session. Returns
 * `{ branch, principal, session }` or throws `{ status, page }`.
 */
export function previewGate({ login, effective, slot, port, detected }) {
  return (req) => {
    const branch = previewBranch(req, { slot, port, effective, detected });
    // As authorizeRequest: an HTTPS request reads the __Host- session cookie.
    req.secureCookies =
      branch === "tailscale" &&
      Boolean(previewConfig(effective).remoteUrl?.startsWith("https://"));
    const token = sessionToken(req, login);
    if (!token)
      throw refusal(401, "signIn", {
        signInUrl: signInUrl(branch, req, { effective, slot, path: req.url || "/" }),
      });
    const session = login.require(token);
    const principal = principalOf(session);
    if (principal.role !== "owner") throw refusal(403, "forbidden");
    return { branch, principal, session };
  };
}
