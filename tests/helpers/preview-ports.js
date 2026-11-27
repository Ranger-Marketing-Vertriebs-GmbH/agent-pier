import { portAvailable } from "../../server/features/pipelines/run-ports.js";

// Below the ephemeral ports of Linux (from 32768) and macOS (from 49152), together
// with the listeners a range gets with Tailscale (slot + 1000): the test's own server
// listens on an ephemeral port, and a preview range that holds AgentPier's port, or
// whose listeners would, is invalid and falls back to the default range.
const lowest = 22000;
const highest = 31000;
const listenerOffset = 1000;

/**
 * A range of `count` consecutive free ports whose Tailscale listeners are free too,
 * kept clear of the default preview range (47100-47109), the pipeline range
 * (20100-20999) and every port the system hands out by itself, so AgentPier's own
 * port in a test never lies in it.
 */
export async function freePortRange(count) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const start = lowest + Math.floor(Math.random() * (highest - lowest - count));
    let free = true;
    for (let port = start; port < start + count && free; port++)
      free = (await portAvailable(port)) && (await portAvailable(port + listenerOffset));
    if (free) return { start, end: start + count - 1 };
  }
  throw new Error("No free port range found");
}
