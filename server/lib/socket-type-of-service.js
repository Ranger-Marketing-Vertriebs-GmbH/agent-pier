import net from "node:net";

const guarded = Symbol.for("agentpier.typeOfServiceGuard");

/**
 * Makes `net.Socket#setTypeOfService` best effort, as undici 8 treats it
 * (nodejs/undici#5547). Node 24's bundled undici 7 calls it unguarded before the
 * first request on a fresh connection (writeH1). On macOS, `setsockopt` fails with
 * EINVAL once the peer reset the connection, so a peer that accepts and resets at
 * once (a browser's DevTools port while it launches or quits) made `fetch` throw an
 * uncaught exception that ended the process instead of rejecting the request
 * (nodejs/undici#6075). A swallowed failure leaves the request to the socket's own
 * error: the fetch rejects with ECONNRESET. Argument errors still throw.
 * Remove once every supported Node release bundles the fix.
 */
export function guardTypeOfService(Socket = net.Socket) {
  const original = Socket.prototype.setTypeOfService;
  if (typeof original !== "function" || original[guarded]) return;
  const setTypeOfService = function (tos) {
    try {
      return original.call(this, tos);
    } catch (error) {
      if (error?.syscall !== "setTypeOfService") throw error;
      return this;
    }
  };
  setTypeOfService[guarded] = true;
  Socket.prototype.setTypeOfService = setTypeOfService;
}

guardTypeOfService();
