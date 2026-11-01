import { defineAgentRuntime, unavailable } from "../agent-runtime.js";
import { HermesSupervisor } from "./hermes-supervisor.js";
import { createHermesHost } from "./hermes-host.js";
import { hermesSessions } from "./hermes-sessions.js";
import { hermesEvents } from "./hermes-events.js";
import { hermesApprovals } from "./hermes-approvals.js";
import { hermesCompiler, hermesConfigCapabilities } from "./hermes-compiler.js";

// The sub-ports Hermes gets in later delivery steps (ADR 0006): reported, never hidden.
const later = unavailable("hermesNotYetSupported");
const laterPorts = [
  "agents",
  "agentFiles",
  "routines",
  "skills",
  "browser",
  "models",
  "channels",
];

/**
 * The Hermes adapter of the agent runtime port (../agent-runtime.js) for one agent,
 * which runs in its own supervised process set (hermes-supervisor.js): the messaging
 * gateway owning the agent's HERMES_HOME and the RPC bridge to its session store.
 * Before each start the supervisor writes the agent's compiled home
 * (hermes-compiler.js) into that HERMES_HOME: `desired()` returns the agent's
 * desiredAgent read (agent-desired-state.js, with the model connection and
 * instructions of a live apply), or null to start the home as it is; `strict` says
 * whether its owner chose every-command approval. Host from hermes-host.js;
 * sessions, events and approvals over the client of the current start. The
 * remaining sub-ports come with later steps and report `hermesNotYetSupported`. Not
 * registered in runtime-for.js yet.
 *
 * Options beside `desired` and `strict` are HermesSupervisor's (`dataDir`, `agentId`,
 * `runtime`, `pathPrepend`, `extra`, timeouts, …). Returns `{ supervisor, runtime,
 * written }`: `written()` lists the home paths the last start wrote or removed.
 */
export function createHermesRuntime({
  desired = () => null,
  strict = false,
  ...options
}) {
  let written = [];
  const prepare = async (agent) => {
    const read = await desired();
    if (!read) return;
    const home = hermesCompiler.compileHome(read, {
      workspace: agent.workspace,
      strict: strict ? [read.runtimeAgentId] : [],
    });
    written = hermesCompiler.write(agent.hermesHome, home);
  };
  const supervisor = new HermesSupervisor({ ...options, prepare });
  const runtime = defineAgentRuntime({
    id: "hermes",
    capabilities: {
      ...hermesConfigCapabilities,
      ...Object.fromEntries(laterPorts.map((name) => [name, later])),
    },
    host: createHermesHost(supervisor),
    sessions: hermesSessions(supervisor),
    events: hermesEvents(supervisor),
    approvals: hermesApprovals(supervisor),
    config: { compiler: hermesCompiler },
  });
  return { supervisor, runtime, written: () => [...written] };
}
