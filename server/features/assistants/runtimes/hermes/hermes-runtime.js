import path from "node:path";
import { available, defineAgentRuntime } from "../agent-runtime.js";
import { HermesSupervisor } from "./hermes-supervisor.js";
import { createHermesHost } from "./hermes-host.js";
import { hermesSessions } from "./hermes-sessions.js";
import { hermesEvents } from "./hermes-events.js";
import { hermesApprovals } from "./hermes-approvals.js";
import { hermesAgentFiles } from "./hermes-files.js";
import { bundledSkillNames, hermesSkills } from "./hermes-skills.js";
import { hermesEnvironment } from "./hermes-environment.js";
import { hermesDeliveries, hermesRoutines } from "./hermes-routines.js";
import { hermesModels } from "./hermes-models.js";
import { hermesChannels } from "./hermes-channels.js";
import { hermesCompiler, hermesConfigCapabilities } from "./hermes-compiler.js";
import { hermesError } from "./hermes-rpc-client.js";
import { liveTeamFiles } from "./hermes-config/team-plugin.js";
import { HermesBrowser } from "./hermes-browser.js";

/**
 * What a Hermes agent offers (agent-runtime.js RUNTIME_CAPABILITIES): host,
 * sessions, events, approvals, config, agents, agentFiles (its memory,
 * instructions and AGENTS.md, hermes-files.js), skills (hermes-skills.js),
 * routines (its gateway's cron, hermes-routines.js), models (the agent's model
 * connection, hermes-models.js), channels (the owner's Telegram through
 * AgentPier's channel layer, hermes-channels.js), channelBots (the agent's own bot
 * for other people on Hermes's Telegram adapter, hermes-config/telegram.js) and the
 * browser on a Chromium AgentPier runs for the agent (hermes-browser.js);
 * every-command approval, which only Hermes has (ADR 0006 decision 5); advanced
 * settings report `advancedSettingsUnsupported`.
 */
export const hermesCapabilities = Object.freeze({
  ...hermesConfigCapabilities,
  everyCommandApproval: available(),
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
 * approval. Host from hermes-host.js; sessions, events, approvals and routines over
 * the client of the current start, and the deliveries of routine results
 * (HermesRoutineDeliveries) following each start's client.
 *
 * - config.apply({ desired, strict, catalog, mcp, connection }): writes the compiled
 *   home now; a running set that this changed restarts, unless only files the gateway
 *   reads at each call changed (liveTeamFiles); a stopped or failed one starts.
 *   `catalog`: `{ [name]: folder }` of the catalog skills it may offer
 *   (hermes-config/skills.js); `mcp`: the MCP store's inputs (mcp-inputs.js
 *   readMcpInputs) for the agent's bound servers (hermes-config/mcp.js), which a
 *   restart loads: Hermes freezes a session's tools, so neither its config watcher
 *   nor `reload.mcp` reaches the chats already open; `connection`: the team
 *   bridge's (hermes-config/team-plugin.js). Later starts keep all three.
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
  let browser = null;
  // `inputs`: the skill catalog, MCP inputs and team bridge an apply named;
  // `settings`: its browser launch settings (`{ executablePath, visible,
  // allowPrivateNetwork }`); the compiled cdp_url names the agent's own port.
  const writeHome = async (agent, read, everyCommand, inputs = {}, settings) => {
    const home = hermesCompiler.compileHome(read, {
      workspace: agent.workspace,
      strict: everyCommand ? [read.runtimeAgentId] : [],
      bundledSkills: bundled,
      catalogSkills: inputs.catalog,
      mcp: inputs.mcp,
      connection: inputs.connection,
      // A port is chosen only for an agent that wants the browser, its own or the
      // one its lead granted it as a temporary member.
      browser:
        settings?.executablePath && (read.browser.wanted || read.browser.borrowed)
          ? {
              cdpUrl: `http://127.0.0.1:${await browser.port()}`,
              allowPrivateNetwork: settings.allowPrivateNetwork === true,
            }
          : undefined,
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
    await writeHome(
      agent,
      read,
      latest ? latest.strict : strictNow(),
      latest?.inputs,
      latest?.browser,
    );
  };
  const supervisor = new HermesSupervisor({ ...options, prepare });
  // The agent's own Chromium: launched for its browser calls, headless unless its
  // setting and a visible browser app allow a window, stopped with the set.
  browser = new HermesBrowser({
    directory: () => path.join(supervisor.agentPaths().home, "agentpier-browser"),
    settings: () =>
      latest?.browser?.executablePath
        ? {
            executablePath: latest.browser.executablePath,
            headless: !(latest.browser.visible && latest.desired?.browser.visible),
          }
        : null,
  });
  const host = createHermesHost(supervisor);
  host.subscribe(({ availability }) => {
    if (["disabled", "failed", "stopping"].includes(availability))
      browser.stop().catch(() => {});
  });
  const agentId = supervisor.agentId;
  const deliveries = hermesDeliveries(supervisor, { dataDir: options.dataDir });
  host.subscribe(() => deliveries.follow(host.ready() ? supervisor.client : null));
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
    routines: hermesRoutines(supervisor, { deliveries }),
    models: hermesModels(supervisor),
    channels: hermesChannels(supervisor),
    browser: {
      request: (call) => browser.request(call),
      openStream: (call) => browser.openStream(call),
      // What AgentPier's browser limits track of this agent's profile.
      profile: () => ({
        cdpPort: browser.knownPort(),
        headless: browser.settings()?.headless !== false,
        directory: browser.userData,
      }),
    },
    config: {
      compiler: hermesCompiler,
      async apply({
        desired: read,
        strict: everyCommand = strictNow(),
        catalog = {},
        mcp,
        connection,
        browser: settings,
      }) {
        latest = {
          desired: read,
          strict: !!everyCommand,
          inputs: { catalog, mcp, connection },
          browser: settings,
        };
        const { availability } = supervisor.status();
        if (!isRunning(availability)) {
          await supervisor.start();
          return { written: [...written], restarted: false };
        }
        const changed = await writeHome(
          supervisor.agentPaths(),
          read,
          !!everyCommand,
          latest.inputs,
          settings,
        );
        const restart = changed.some((file) => !liveTeamFiles.includes(file));
        if (restart) await supervisor.restart();
        else await supervisor.start();
        return { written: changed, restarted: restart };
      },
    },
    // One runtime agent per set: every connection serves the same one.
    agents: { ...agents, on: () => agents },
  });
  return { supervisor, runtime, written: () => [...written] };
}
