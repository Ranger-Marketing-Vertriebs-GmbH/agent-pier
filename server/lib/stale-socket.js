import fs from "node:fs";
import net from "node:net";

const defaultErrors = {
  unsafe: () => new Error("Unsafe Local socket."),
  live: () => new Error("Local socket already in use."),
  changed: () => new Error("Local socket changed."),
};

function refused(socketPath, timeout) {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
    probe.setTimeout(timeout, () => {
      probe.destroy();
      resolve(false);
    });
  });
}

/**
 * Clear the way for a listener at `socketPath`. Nothing there is fine. Anything else
 * must be a Unix socket owned by this user that refuses a connection (nobody listens),
 * and still the same inode after that probe; only then is it removed. A live socket,
 * a foreign or non-socket file, or a swap during the probe throws the matching error
 * from `errors` ({ unsafe, live, changed }).
 */
export async function clearStaleSocket(socketPath, errors = {}, { timeout = 1000 } = {}) {
  const fail = { ...defaultErrors, ...errors };
  let previous;
  try {
    previous = fs.lstatSync(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!previous.isSocket() || (process.getuid && previous.uid !== process.getuid()))
    throw fail.unsafe();
  if (!(await refused(socketPath, timeout))) throw fail.live();
  const current = fs.lstatSync(socketPath);
  if (previous.ino !== current.ino || previous.dev !== current.dev) throw fail.changed();
  fs.unlinkSync(socketPath);
}
