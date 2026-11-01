import { available, defineAgentRuntime, unavailable } from "../agent-runtime.js";
import { HermesSupervisor } from "./hermes-supervisor.js";
import { createHermesHost } from "./hermes-host.js";
import { hermesSessions } from "./hermes-sessions.js";
import { hermesEvents } from "./hermes-events.js";
import { hermesApprovals } from "./hermes-approvals.js";
import { hermesAgentFiles } from "./hermes-files.js";
import { bundledSkillNames, hermesSkills } from "./hermes-skills.js";
import { hermesEnvironment } from "./hermes-environment.js";
import { hermesCompiler, hermesConfigCapabilities } from "./hermes-compiler.js";
import { hermesError } from "./hermes-rpc-client.js";

// The sub-ports Hermes gets in later delivery steps (ADR 0006): reported, never hidden.
const later = unavailable("hermesNotYetSupported");
const laterPorts = ["routines", "browser", "models", "channels"];

/**
 * What a Hermes agent offers (agent-runtime.js RUNTIME_CAPABILITIES): host,
 * sessions, events, approvals, config, agents, agentFiles (its memory,
 * instructions and AGENTS.md, hermes-files.js) and skills (hermes-skills.js);
 * every-command approval, which only
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
 * - config.apply({ desired, strict, catalog, mcp }): writes the compiled home now;
 *   a running set that this changed restarts, a stopped or failed one starts.
 *   `catalog`: `{ [name]: folder }` of the catalog skills it may offer
 *   (hermes-config/skills.js); `mcp`: the MCP store's inputs (mcp-inputs.js
 *   readMcpInputs) for the agent's bound servers (hermes-config/mcp.js), which a
 *   restart loads: Hermes freezes a session's tools, so neither its config watcher
 *   nor `reload.mcp` reaches the chats already open. Later starts keep both.
 *   Resolves `{ written, restarted }`.
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
  // The installation the set last started with, and the names it bundles.
  let installed = null;
  let bundled;
  const strictNow = () => (typeof strict === "function" ? !!strict() : !!strict);
  const writeHome = (agent, read, everyCommand, inputs = {}) => {
    const home = hermesCompiler.compileHome(read, {
      workspace: agent.workspace,
      strict: everyCommand ? [read.runtimeAgentId] : [],
      bundledSkills: bundled,
      catalogSkills: inputs.catalog,
      mcp: inputs.mcp,
    });
    written = hermesCompiler.write(agent.hermesHome, home);
    return written;
  };
  const prepare = async (agent, record) => {
    if (record && record !== installed) {
      installed = record;
      bundled = bundledSkillNames(record);
    }
    const read = latest?.desired ?? (await desired());
    if (!read) return;
    writeHome(agent, read, latest ? latest.strict : strictNow(), latest?.inputs);
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
    skills: hermesSkills(supervisor, {
      installed: () => installed,
      // The agent's PATH, where a skill's programs must be found.
      folders: (record) =>
        hermesEnvironment({
          agent: supervisor.agentPaths(),
          runtime: record,
          pathPrepend: supervisor.pathPrepend,
        }).PATH.split(":"),
    }),
    config: {
      compiler: hermesCompiler,
      async apply({
        desired: read,
        strict: everyCommand = strictNow(),
        catalog = {},
        mcp,
      }) {
        latest = { desired: read, strict: !!everyCommand, inputs: { catalog, mcp } };
        const { availability } = supervisor.status();
        if (!isRunning(availability)) {
          await supervisor.start();
          return { written: [...written], restarted: false };
        }
        const changed = writeHome(
          supervisor.agentPaths(),
          read,
          !!everyCommand,
          latest.inputs,
        );
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
