import path from "node:path";
import { createHash } from "node:crypto";
import * as runtime from "../../../vendor/agentbus/agentpier/runtime.js";
import * as peers from "../../../vendor/agentbus/core/peers.js";
import { nudge } from "../../../vendor/agentbus/core/nudge.js";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import { claudeRegistryEntry } from "../../../vendor/agentbus/hooks/register.js";

export const AGENTBUS_VERSION = "agentpier-3";
// Existing unbrokered helpers retain h/peers. They must neither discover nor wake
// newly brokered peers. Keep durable queues/identities in place across reloads.
const peerHome = (home) => path.join(home, "broker");
export const trustedPeers = (home, ps) => runtime.trustedPeers(home, ps, peerHome(home));
export const registerPeer = (ctx, nativeSessionId, options) =>
  runtime.registerPeer({ ...ctx, peerHome: peerHome(ctx.h) }, nativeSessionId, options);
export const register = (home, peer) => peers.register(peerHome(home), peer);
export const unregister = (home, key) => peers.unregister(peerHome(home), key);
// How each runtime is woken, from the peer the broker registered and the launch the
// server kept. Null means no wake channel right now; a throw means none at all.
const wakeTargets = {
  codex: (current, launch) => ({
    kind: "codex-queue",
    threadId: current.nativeSessionId,
    command: launch.command,
    codexHome: launch.codexHome,
  }),
  claude(current, launch, { ps = pidStart }) {
    const entry = claudeRegistryEntry(current.nativeSessionId, launch.claudeSessionsDir, {
      ps,
    });
    if (entry.pid !== current.pid) return null;
    return {
      kind: "cc-socks",
      socketPath: entry.messagingSocketPath,
      keyPath: entry.keyPath,
      pid: entry.pid,
    };
  },
  opencode(current, launch, deps, home) {
    if (!current.socketPath) return null;
    // The pathname is derived from this project and process, never from peer input.
    const hash = createHash("sha256").update(home).digest("hex").slice(0, 12);
    const socketRoot = `/tmp/ap-bus-${process.getuid?.() || 0}-${hash}`;
    return {
      kind: "oc-sock",
      socketPath: path.join(socketRoot, `${current.pid}.sock`),
      sessionId: current.nativeSessionId,
    };
  },
};

/**
 * Wakes `peer` the way the vendored `trustedNudge` does, but with the launch the
 * server kept for itself (`AgentBusAccess#record`): the Codex binary it runs, the
 * Codex home it names and the folder it reads a Claude session's socket and key from
 * never come from the launch record in the project's bus folder, which a sandboxed
 * session may write.
 */
export async function trustedNudge(home, launch, peer, text, from, deps = {}) {
  const current = trustedPeers(home, deps.ps).find(
    (item) => item.key === peer.key && item.alive,
  );
  if (!current || current.agentpierSessionId !== launch?.id) return false;
  let wake;
  try {
    wake = wakeTargets[current.runtime]?.(current, launch, deps, home);
  } catch {
    return false;
  }
  return nudge({ ...current, nudge: wake ?? { kind: "none" } }, text, from, deps);
}
