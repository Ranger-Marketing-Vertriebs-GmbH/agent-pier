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
import { ddgsInstalled } from "./hermes-config/web.js";
import fs from "node:fs";
import {
  advancedHome,
  advancedZone,
  homeReasoning,
  liveConfigChange,
} from "./hermes-config/advanced.js";
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
 * every-command approval, which only Hermes has (ADR 0006 decision 5); and the
 * owner's advanced settings it has an equivalent of (hermes-config/advanced.js).
 */
export const hermesCapabilities = Object.freeze({
  ...hermesConfigCapabilities,
  everyCommandApproval: available(),
});

const isRunning = (availability) => !["disabled", "failed"].includes(availability);
const readConfig = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/**
 * The Hermes adapter of the agent runtime port (../agent-runtime.js) for one agent,
 * which runs in its own supervised process set (hermes-supervisor.js): the messaging
 * gateway owning the agent's HERMES_HOME and the RPC bridge to its session store.
 * Before each start the supervisor writes the agent's compiled home
 * (hermes-compiler.js) into that HERMES_HOME: the desiredAgent read (with the model
 * connection and instructions of a live apply) the last `config.apply` named, else
 * `desired()`'s, or none to start the home as it is. `strict` (a boolean, or a
 * function answering one at each start) says whether its owner chose every-command
 * approval. `advanced()` answers the owner's advanced settings for all agents by
 * setting id (advanced-config.js advancedValues), read at each write, or undefined to
 * leave their keys as they are. Host from hermes-host.js; sessions, events, approvals
 * and routines over the client of the current start, and the deliveries of routine
 * results (HermesRoutineDeliveries) following each start's client; both run cron
 * expressions in the zone the current start gave the agent's processes
 * (HERMES_TIMEZONE from advanced(), else the host's).
 *
 * - config.apply({ desired, strict, catalog, mcp, connection }): writes the compiled
 *   home now; a running set that this changed restarts, unless only files the gateway
 *   reads at each call changed (liveTeamFiles) or config.yaml only in the thinking
 *   level (hermes-config/advanced.js liveConfigChange); a changed time zone restarts
 *   it too; a stopped or failed one starts.
 *   `catalog`: `{ [name]: folder }` of the catalog skills it may offer
 *   (hermes-config/skills.js); `mcp`: the MCP store's inputs (mcp-inputs.js
 *   readMcpInputs) for the agent's bound servers (hermes-config/mcp.js), which a
 *   restart loads: Hermes freezes a session's tools, so neither its config watcher
 *   nor `reload.mcp` reaches the chats already open; `connection`: the team
 *   bridge's (hermes-config/team-plugin.js); `pdfFallback`: the owner's PDF fallback
 *   connection (hermes-config/pdf.js). Later starts keep them.
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
  advanced = () => undefined,
  // Runs before each start with the runtime agent id (hermes-wiring.js: the chat
  // file move), before the home is written.
  prepareFiles = async () => {},
  ...options
}) {
  let written = [];
  // The HERMES_TIMEZONE of the current start (null: the host's zone).
  let zone = null;
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
      modelProxy: inputs.modelProxy,
      imageLogin: inputs.imageLogin,
      pdfFallback: inputs.pdfFallback,
      // The owner's advanced settings, for the installation they were approved for.
      advanced: advancedInput(),
      // The owner's web search settings, once the installation (ddgs) is known.
      web:
        inputs.web && installed
          ? { search: inputs.web.search, ddgs: ddgsInstalled(installed) }
          : undefined,
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
    // The sessions sub-port sends a turn's images only to a home that takes them
    // natively; a change of it changes config.yaml, which restarts the set.
    supervisor.nativeImages = home.nativeImages === true;
    return written;
  };
  const advancedInput = () => {
    const values = advanced();
    return values && installed ? { version: installed.version, values } : undefined;
  };
  const prepare = async (agent, record) => {
    await prepareFiles(supervisor.agentId);
    if (record && record !== installed) {
      installed = record;
      bundled = bundledSkillNames(record);
    }
    const read = latest?.desired ?? (await desired());
    if (read)
      await writeHome(
        agent,
        read,
        latest ? latest.strict : strictNow(),
        latest?.inputs,
        latest?.browser,
      );
    // A start without a desired state still takes the owner's advanced settings, so
    // an update or rollback to a version they are not approved for drops them. A home
    // that cannot take them starts as it is, as it did before they existed.
    else
      try {
        hermesCompiler.write(agent.hermesHome, advancedHome(advancedInput(), agent));
      } catch (error) {
        console.warn(`Hermes advanced settings not written: ${error?.code || "ERROR"}`);
      }
    // The zone this start's processes run their clock and cron in; unknown values
    // keep the zone of the last start.
    const input = advancedInput();
    if (input) supervisor.timezone = advancedZone(input);
    zone = supervisor.timezone ?? null;
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
  const zoneNow = () => zone;
  const deliveries = hermesDeliveries(supervisor, {
    dataDir: options.dataDir,
    zone: zoneNow,
  });
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
    sessions: hermesSessions(supervisor, {
      reasoning: () => homeReasoning(supervisor.agentPaths().hermesHome),
    }),
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
    routines: hermesRoutines(supervisor, { deliveries, zone: zoneNow }),
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
        web,
        modelProxy,
        imageLogin,
        pdfFallback,
      }) {
        latest = {
          desired: read,
          strict: !!everyCommand,
          inputs: { catalog, mcp, connection, web, modelProxy, imageLogin, pdfFallback },
          browser: settings,
        };
        // The agent's shell PATH starts with its GitHub folder and its SSH agent's
        // bin/ (desired shell.pathPrepend); the gateway's PATH is its commands', read
        // at its start (tools/environments/local.py), so a change restarts the set.
        const pathPrepend = [...(read?.shell?.pathPrepend || [])];
        const pathChanged =
          JSON.stringify(pathPrepend) !== JSON.stringify(supervisor.pathPrepend || []);
        supervisor.pathPrepend = pathPrepend;
        const { availability } = supervisor.status();
        if (!isRunning(availability)) {
          await supervisor.start();
          return { written: [...written], restarted: false };
        }
        // The zone reaches the processes at their start only.
        const input = advancedInput();
        const zoneChanged =
          !!input && advancedZone(input) !== (supervisor.timezone ?? null);
        const paths = supervisor.agentPaths();
        const config = path.join(paths.hermesHome, "config.yaml");
        const before = readConfig(config);
        const changed = await writeHome(
          paths,
          read,
          !!everyCommand,
          latest.inputs,
          settings,
        );
        // The gateway reads the thinking level again at each turn.
        const live = (file) =>
          liveTeamFiles.includes(file) ||
          (file === "config.yaml" && liveConfigChange(before, readConfig(config)));
        const restart = pathChanged || zoneChanged || changed.some((file) => !live(file));
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
