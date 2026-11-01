import { portAvailable } from "../../server/features/pipelines/run-ports.js";

/**
 * A range of `count` consecutive free ports, kept clear of the default preview range
 * (47100-47109), AgentPier's port and the pipeline range.
 */
export async function freePortRange(count) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const start = 40000 + Math.floor(Math.random() * (5000 - count));
    let free = true;
    for (let port = start; port < start + count && free; port++)
      free = await portAvailable(port);
    if (free) return { start, end: start + count - 1 };
  }
  throw new Error("No free port range found");
}
