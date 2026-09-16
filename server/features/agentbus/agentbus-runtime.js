import path from "node:path";
import * as runtime from "../../../vendor/agentbus/agentpier/runtime.js";
import * as peers from "../../../vendor/agentbus/core/peers.js";

export const AGENTBUS_VERSION = "agentpier-3";
// Existing unbrokered helpers retain h/peers. They must neither discover nor wake
// newly brokered peers. Keep durable queues/identities in place across reloads.
const peerHome = (home) => path.join(home, "broker");
export const trustedPeers = (home, ps) => runtime.trustedPeers(home, ps, peerHome(home));
export const registerPeer = (ctx, nativeSessionId, options) =>
  runtime.registerPeer({ ...ctx, peerHome: peerHome(ctx.h) }, nativeSessionId, options);
export const register = (home, peer) => peers.register(peerHome(home), peer);
export const unregister = (home, key) => peers.unregister(peerHome(home), key);
export const trustedNudge = (home, peer, text, from, deps = {}) =>
  runtime.trustedNudge(home, peer, text, from, { ...deps, peerHome: peerHome(home) });
