import { available, defineAgentRuntime, unavailable } from "../agent-runtime.js";
import { HermesSupervisor } from "./hermes-supervisor.js";
import { createHermesHost } from "./hermes-host.js";
import { hermesSessions } from "./hermes-sessions.js";
import { hermesEvents } from "./hermes-events.js";
import { hermesApprovals } from "./hermes-approvals.js";
import { hermesAgentFiles } from "./hermes-files.js";
import { hermesCompiler, hermesConfigCapabilities } from "./hermes-compiler.js";
import { hermesError } from "./hermes-rpc-client.js";

// The sub-ports Hermes gets in later delivery steps (ADR 0006): reported, never hidden.
const later = unavailable("hermesNotYetSupported");
const laterPorts = ["routines", "skills", "browser", "models", "channels"];

/**
 * What a Hermes agent offers (agent-runtime.js RUNTIME_CAPABILITIES): host,
 * sessions, events, approvals, config, agents and agentFiles (its memory,
 * instructions and AGENTS.md, hermes-files.js); every-command approval, which only
 * Hermes has (ADR 0006 decision 5); the sub-ports of later steps report
 * `hermesNotYetSupported`, advanced settings `advancedSettingsUnsupported`.
 */
export const hermesCapabilities = Object.freeze({
  ...hermesConfigCapabilities,
  everyCommandApproval: available(),
  ...Object.fromEntries(laterPorts.map((name) => [name, later])),
});

const isRunning = (availability) => !["disabled", "failed"].includes(availability);

/**
 * The Hermes adapter of the agent runtime port (../agent-runtime.js) for one agent,
 * which runs in its own supervised process set (hermes-supervisor.js): the messaging
 * gateway owning the agent's HERMES_HOME and the RPC bridge to its session store.
 * Before each start the supervisor writes the agent's compiled home
 * (hermes-compiler.js) into that HERMES_HOME: the desiredAgent read (with the model
 * connection and instructions of a live apply) the last `config.apply` named, else
 * `desired()`'s, or none to start the home as it is. `strict` (a boolean, or a
 * function answering one at each start) says whether its owner chose every-command
 * approval. Host from hermes-host.js; sessions, events and approvals over the client
 * of the current start.
 *
 * - config.apply({ desired, strict }): writes the compiled home now; a running set
 *   that this changed restarts, a stopped or failed one starts. Resolves `{ written,
 *   restarted }`.
 * - agents: one runtime agent, the set's own: list() names it while ready; create and
 *   update leave the home to config.apply; delete({ deleteFiles }) stops the set and,
 *   with deleteFiles, calls `remove()` (the fleet's, which removes its folders).
 *
 * Options beside `desired`, `strict` and `remove` are HermesSupervisor's (`dataDir`,
 * `agentId`, `runtime`, `pathPrepend`, `extra`, timeouts, …). Returns `{ supervisor,
 * runtime, written }`: `written()` lists the home paths the last write changed.
 */
export function createHermesRuntime({
  desired = () => null,
  strict = false,
  remove = async () => {},
  ...options
}) {
  let written = [];
  let latest = null;
  const strictNow = () => (typeof strict === "function" ? !!strict() : !!strict);
  const writeHome = (agent, read, everyCommand) => {
    const home = hermesCompiler.compileHome(read, {
      workspace: agent.workspace,
      strict: everyCommand ? [read.runtimeAgentId] : [],
    });
    written = hermesCompiler.write(agent.hermesHome, home);
    return written;
  };
  const prepare = async (agent) => {
    const read = latest?.desired ?? (await desired());
    if (!read) return;
    writeHome(agent, read, latest ? latest.strict : strictNow());
  };
  const supervisor = new HermesSupervisor({ ...options, prepare });
  const host = createHermesHost(supervisor);
  const agentId = supervisor.agentId;
  const ready = () => {
    if (!host.ready()) throw hermesError();
  };
  const agents = {
    list: async () => {
      ready();
      return { agents: [{ id: agentId }] };
    },
    create: async () => ({ agentId }),
    update: async () => ({ agentId }),
    async delete({ deleteFiles = false } = {}) {
      await supervisor.stop();
      if (deleteFiles) await remove();
      return { ok: true, agentId };
    },
    waitListed: async () => ready(),
    settled: async () => {},
    admitted: async () => false,
    degraded: () => [],
    noteRefusal: () => null,
    admitting: () => false,
  };
  const runtime = defineAgentRuntime({
    id: "hermes",
    capabilities: hermesCapabilities,
    host,
    sessions: hermesSessions(supervisor),
    events: hermesEvents(supervisor),
    approvals: hermesApprovals(supervisor),
    agentFiles: hermesAgentFiles(supervisor),
    config: {
      compiler: hermesCompiler,
      async apply({ desired: read, strict: everyCommand = strictNow() }) {
        latest = { desired: read, strict: !!everyCommand };
        const { availability } = supervisor.status();
        if (!isRunning(availability)) {
          await supervisor.start();
          return { written: [...written], restarted: false };
        }
        const changed = writeHome(supervisor.agentPaths(), read, !!everyCommand);
        if (changed.length) await supervisor.restart();
        else await supervisor.start();
        return { written: changed, restarted: changed.length > 0 };
      },
    },
    // One runtime agent per set: every connection serves the same one.
    agents: { ...agents, on: () => agents },
  });
  return { supervisor, runtime, written: () => [...written] };
}
