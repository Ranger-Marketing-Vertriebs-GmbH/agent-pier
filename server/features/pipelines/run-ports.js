import net from "node:net";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { terminal } from "./graph-navigation.js";

// Every active native turn leases a block of ports from this range: AGENTPIER_PORT and
// the next PORT_BLOCK - 1 ports. Blocks start every PORT_STRIDE ports, so a turn's
// ports read as one number (20110, 20111, 20112). The default stays clear of AgentPier
// (4380), Vite (5173), the test ports and the Linux and macOS ephemeral ranges.
export const DEFAULT_PORT_RANGE = Object.freeze({ start: 20100, end: 20999 });
export const PORT_BLOCK = 3;
const PORT_STRIDE = 10;

// Operator override from config.json `pipelines`; an invalid range keeps the default.
export function pipelinePorts(saved) {
  const start = saved?.portRangeStart,
    end = saved?.portRangeEnd;
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1024 &&
    end <= 65535 &&
    end - start + 1 >= PORT_STRIDE
  )
    return { portRange: { start, end } };
  return {};
}

// The variables of one native turn. The browser session is named per run and stage,
// so a stage's later turns can reuse it and parallel stages never share one.
export function turnEnvironment({ runId, nodeId, ports }) {
  return {
    AGENTPIER_RUN_ID: runId,
    AGENTPIER_STAGE_ID: nodeId,
    ...(ports
      ? { AGENTPIER_PORT: String(ports.base), AGENTPIER_PORT_COUNT: String(ports.count) }
      : {}),
    AGENTPIER_BROWSER_SESSION: browserSession(runId, nodeId),
  };
}
export const browserSession = (runId, nodeId) => `agentpier-${runId}-${nodeId}`;

/**
 * Port leases of active turns. The run store is the durable record: a block is leased
 * while a live run's active turn holds it, so ending, parking or cancelling the turn
 * releases it, and a restarted engine rebuilds every lease from the stored runs.
 * In memory are only the blocks granted but not yet saved with their turn.
 */
export class PortLeases {
  constructor({ range = DEFAULT_PORT_RANGE, probe = portAvailable, runs }) {
    Object.assign(this, { range, probe, runs });
    this.reserved = new Map();
  }
  leased() {
    const bases = new Set(this.reserved.values());
    for (const run of this.runs())
      if (!terminal(run) && !run.imported?.historyOnly) {
        // One active turn per run today; a parallel group adds its members here.
        const base = run.activeTurn?.ports?.base;
        if (Number.isInteger(base)) bases.add(base);
      }
    return bases;
  }
  blocks() {
    const blocks = [];
    for (
      let base = this.range.start;
      base + PORT_BLOCK - 1 <= this.range.end;
      base += PORT_STRIDE
    )
      blocks.push(base);
    return blocks;
  }
  /** Grants a free block to `turnId`; `settle` once the turn holding it is saved. */
  async lease({ turnId, prefer }) {
    const blocks = this.blocks();
    const order = blocks.includes(prefer)
      ? [prefer, ...blocks.filter((base) => base !== prefer)]
      : blocks;
    let leased = this.leased();
    for (const base of order) {
      if (leased.has(base)) continue;
      // Reserved before the probe, so a concurrent lease cannot pick it meanwhile.
      this.reserved.set(turnId, base);
      if (await this.blockAvailable(base)) return { base, count: PORT_BLOCK };
      this.reserved.delete(turnId);
      // Other leases may have been granted or saved while this one probed.
      leased = this.leased();
    }
    throw problem(serverMessages.pipelines.portRangeExhausted, 409);
  }
  settle(turnId) {
    this.reserved.delete(turnId);
  }
  async blockAvailable(base) {
    for (let port = base; port < base + PORT_BLOCK; port++)
      if (!(await this.probe(port))) return false;
    return true;
  }
}

// Best effort: a port is skipped when anything listens on it on loopback or on all
// interfaces. A server that starts after the probe is not detected.
export async function portAvailable(port) {
  for (const host of ["127.0.0.1", undefined])
    if (!(await listens(port, host))) return false;
  return true;
}
function listens(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}
