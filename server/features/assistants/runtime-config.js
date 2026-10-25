import path from "node:path";
import { randomBytes } from "node:crypto";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { guardGatedTools, memberTeamTools, memoryTools } from "./native-capabilities.js";
import { agentEntry } from "./openclaw-config/agent-entry.js";
import { hardenedDefaults } from "./openclaw-config/locked-core.js";
import { applyOverrides } from "./openclaw-config/overrides.js";
import { applyShell, shellSections, withoutShell } from "./openclaw-config/shell.js";
import { dreamingSection } from "./openclaw-config/dreaming.js";
import { applyMcp, mcpSections } from "./openclaw-config/mcp-servers.js";
import {
  applyTelegram,
  configuredAgents,
  stdioAgents,
  telegramSections,
} from "./openclaw-config/telegram-senders.js";
import {
  applyWebTools,
  webToolsAvailability,
  webToolsSections,
} from "./openclaw-config/web-tools.js";

export const teamTools = [
  "session_status",
  "agentpier_team_propose",
  "agentpier_team_status",
  "agentpier_team_stop",
  "agentpier_team_members",
  "agentpier_team_ask",
  "agentpier_team_delegate",
  "agentpier_team_cancel",
  "agentpier_team_archive",
  "agentpier_team_grant",
  "agentpier_team_member_update",
  "agentpier_team_member_summarise",
  "agentpier_team_models",
  "agentpier_team_member_routine",
  "agentpier_team_promote",
  "agentpier_team_templates",
  // Members' own; each agent's entry decides who holds them (profileTools).
  ...memberTeamTools,
];

/**
 * The global `tools.allow` of a native team Gateway before applyWebTools and applyMcp
 * append their tools. Live MCP applies start from the same list.
 */
export const nativeTools = [
  ...teamTools,
  ...memoryTools,
  "agentpier_reminder",
  "agentpier_routine",
  "agentpier_workspace",
  "agentpier_ssh",
  "agentpier_share_file",
  "agentpier_goal",
];

function freshDefaults(paths) {
  const hardened = hardenedDefaults();
  return {
    agents: {
      defaults: {
        workspace: paths.workspaces,
        skipBootstrap: true,
        heartbeat: hardened.heartbeat,
      },
      entries: { main: {} },
    },
    channels: hardened.channels,
    browser: hardened.browser,
    cron: { enabled: false },
    plugins: { slots: { memory: "none" } },
    skills: { allowBundled: hardened.skillsAllowBundled },
    tools: { allow: ["session_status"] },
    discovery: hardened.discovery,
    telemetry: hardened.telemetry,
    update: hardened.update,
  };
}

/**
 * OpenClaw 2026.10 refuses to start with the legacy roster shapes that 2026.9.x still
 * migrated in memory: an `agents.list` array, or a boolean `default` marker on an
 * entry. Both now need `openclaw doctor --fix`. This writes the canonical shape that
 * 2026.9.9's own `agents.create` persists: keyed `agents.entries` without markers,
 * and a roster of two or more agents with explicit ownership whose system and talk
 * surfaces stay with the former default agent. Configurations already canonical pass
 * through unchanged.
 */
export function canonicalAgentRoster(config) {
  const agents = config.agents;
  if (!agents || typeof agents !== "object") return config;
  if (Array.isArray(agents.list)) {
    if (
      !agents.entries ||
      typeof agents.entries !== "object" ||
      Array.isArray(agents.entries)
    )
      agents.entries = Object.fromEntries(
        agents.list
          .filter((entry) => entry && typeof entry.id === "string" && entry.id)
          .map(({ id, ...entry }) => [id, entry]),
      );
    delete agents.list;
  }
  const entries = Object.entries(agents.entries || {});
  const marked = entries.find(([, entry]) => entry?.default === true)?.[0];
  for (const [, entry] of entries)
    if (entry && typeof entry.default === "boolean") delete entry.default;
  if (entries.length > 1 && agents.ownership === undefined) {
    const owner = marked || "main";
    agents.ownership = "explicit";
    agents.defaults = {
      ...agents.defaults,
      systemAgent: { agentId: owner, ...agents.defaults?.systemAgent },
    };
    config.talk = { agentId: owner, ...config.talk };
  }
  return config;
}

// Pure: the same inputs and runtime state always yield the same configuration.
export function compileOpenClawConfig({
  existing,
  paths,
  port,
  token,
  teams,
  overrides = [],
  runtime: { maintenance = false } = {},
  tls,
  // { search, browser, searchPlugins }; see openclaw-config/web-tools.js.
  webTools,
  // { pathPrepend }: the owner's login PATH for agents with shell; see exec-shell.js.
  shell,
  // { servers, bindings, secrets }; see openclaw-config/mcp-servers.js readMcpInputs.
  mcp,
  // { accounts, speech }; see openclaw-config/telegram-senders.js readTelegramInputs.
  telegram,
  // { [runtimeAgentId]: names } assigned skills a same-named skill would replace.
  skillShadows = {},
}) {
  const config = canonicalAgentRoster(
    applyOverrides(existing || freshDefaults(paths), overrides),
  );
  // Paths are this installation's; a restored or copied configuration cannot pick them.
  config.agents = {
    ...config.agents,
    defaults: { ...config.agents?.defaults, workspace: paths.workspaces },
  };
  const hardened = hardenedDefaults();
  config.channels = hardened.channels;
  // Assigned outright: a stale browser block must not survive a disabled capability.
  // applyWebTools sets the verified block when an agent uses an available browser.
  config.browser = hardened.browser;
  config.discovery = hardened.discovery;
  config.telemetry = hardened.telemetry;
  config.update = hardened.update;
  // Not a gate: OpenClaw reads an empty allowBundled as "every bundled skill". The
  // agents' own lists are the gate (agents.defaults.skills below, agentEntry).
  config.skills = { ...config.skills, allowBundled: hardened.skillsAllowBundled };
  config.agents.defaults.heartbeat = hardened.heartbeat;
  // Compiler-owned: only applyWebTools sets the image model, while an agent creates
  // images and a ChatGPT account is ready; a stale one would keep the tool offered.
  if (config.agents.defaults.mediaModels) {
    const { image: _image, ...media } = config.agents.defaults.mediaModels;
    if (Object.keys(media).length) config.agents.defaults.mediaModels = media;
    else delete config.agents.defaults.mediaModels;
  }
  // Compiler-owned: only the start's provider preparation writes the PDF model (the
  // owner's fallback or a placeholder) while the start offers pdf (pdf-policy.js).
  delete config.agents.defaults.pdfModel;
  // Compiler-owned: an MCP server could run host commands. Only applyMcp writes it,
  // from the servers bound to eligible agents.
  delete config.mcp;
  // Likewise `secrets` and `env`: AgentPier never writes them and they are locked.
  delete config.secrets;
  delete config.env;
  const enabled = !!(teams?.directory && teams?.connection);
  // Without a mode the gateway host runs exec in "full"; "deny" is the default every
  // agent without its own override gets (openclaw-config/shell.js).
  // Session tools reach only the calling agent's own sessions; OpenClaw's default
  // "all" would let one agent read another's transcripts.
  config.tools = {
    allow: enabled ? teamTools : ["session_status"],
    toolSearch: false,
    exec: { mode: "deny" },
    sessions: { visibility: "agent" },
  };
  // Only a profile compiled below can regain shell grants.
  for (const entry of Object.values(config.agents.entries || config.agents.list || {}))
    withoutShell(entry);
  config.plugins = {
    slots: { memory: "none" },
    ...(enabled
      ? {
          // The allow list is restrictive: OpenClaw offers only the provider logins
          // of plugins it lists, so the ChatGPT device-code sign-in needs `openai`.
          allow: ["agentpier-teams", "openai"],
          load: { paths: [teams.directory] },
          entries: {
            "agentpier-teams": {
              enabled: true,
              // The plugin reads each run's model input to know which background
              // commands a completion run reports (team-plugin/exec-processes.js).
              hooks: { allowConversationAccess: true },
              // The plugin classifies absolute write targets below this root.
              config: { ...teams.connection, workspaces: paths.workspaces },
              // Its chat title method runs on the asking agent's own model
              // (team-plugin/chat-title.js); no other model or login can be chosen.
              llm: { allowAgentIdOverride: true },
            },
          },
        }
      : {}),
  };
  // The agents' own bots, compiled below; their agents lose the session tools.
  const telegramCompiled = telegramSections({
    profiles: teams?.profiles,
    telegram: enabled && teams.native ? telegram : undefined,
    agents: configuredAgents(config),
    stdio: stdioAgents(mcp || {}),
    ssh: teams?.sshAgents,
  });
  if (enabled && teams.native) {
    // memory and skills.workshop are written only here; otherwise they stay inert
    // (memory slot "none", cron off).
    config.plugins.slots.memory = "memory-core";
    config.plugins.allow.push("memory-core");
    config.plugins.entries["memory-core"] = {
      enabled: true,
      config: { dreaming: dreamingSection(teams.dreaming || {}) },
    };
    config.memory = {
      search: {
        enabled: false,
        provider: "none",
        sources: ["memory"],
        rememberAcrossConversations: false,
      },
    };
    // Enabling cron must not also opt agents into automatic skill maintenance.
    config.skills = {
      ...config.skills,
      workshop: {
        ...config.skills?.workshop,
        autonomous: { mode: "off" },
      },
    };
    config.tools.allow = [...nativeTools];
    config.tools.fs = { workspaceOnly: true };
    config.cron = {
      enabled: true,
      webhookToken: teams.native.token,
      webhookSsrfPolicy: { allowedHostnames: ["127.0.0.1"] },
    };
    // Unused or unavailable web capabilities leave every section as above.
    applyWebTools(config, webToolsSections({ profiles: teams.profiles, webTools, port }));
    applyShell(config, shellSections({ profiles: teams.profiles }));
    // Without bindings to usable servers nothing is added.
    const mcpServers = mcpSections({ profiles: teams.profiles, ...mcp });
    applyMcp(config, mcpServers);
    const available = webToolsAvailability(webTools);
    const entries = config.agents.entries || config.agents.list;
    for (const [key, entry] of Object.entries(entries || {})) {
      delete entry.skills;
      // A fresh Gateway has not proven its tool guard yet; no profile keeps writes or
      // the browser.
      if (Array.isArray(entry.tools?.allow))
        entry.tools.allow = entry.tools.allow.filter((t) => !guardGatedTools.includes(t));
      const profile = teams.profiles?.find((a) => a.runtimeAgentId === (entry.id || key));
      // OpenClaw's own `main` agent is no AgentPier agent: it never inherits the global
      // list, which offers every available web tool (web-tools.js).
      if (!profile && (entry.id || key) === "main")
        entry.tools = { ...entry.tools, allow: ["session_status"] };
      if (!profile) continue;
      Object.assign(
        entry,
        agentEntry(entry, profile, {
          teamsReady: true,
          nativeReady: true,
          guardProven: false,
          available,
          // An agent with GitHub access and shell starts with its GitHub folder.
          pathPrepend: [
            ...(teams.githubShell?.[profile.id] || []),
            ...(shell?.pathPrepend || []),
          ],
          mcpTools: mcpServers.agentTools[profile.runtimeAgentId],
          senderFacing: !!telegramCompiled.accounts[profile.runtimeAgentId],
          ssh: !!teams.sshAgents?.has(profile.id),
          shadowedSkills: skillShadows[profile.runtimeAgentId],
        }),
      );
    }
  }
  // Only the native team start compiles the agents' own bots; any other start, and
  // every start without bots, removes what an earlier one wrote.
  applyTelegram(config, telegramCompiled);
  // Every AgentPier chat is a dashboard session, and OpenClaw archives those after 7
  // idle days; an archived session takes no turn. AgentPier keeps archive state for
  // its chats itself (agent-chats.js), so that trigger stays off. `pruneAfter` and
  // `maxEntries` stay: pinning keeps the chats out of them (native-chat-archive.js).
  config.session = {
    ...config.session,
    maintenance: { ...config.session?.maintenance, archiveDashboardAfter: false },
  };
  config.cron = { ...config.cron, enabled: !!(enabled && teams.native && !maintenance) };
  // No skills for an agent without its own list: OpenClaw reads agents.defaults.skills
  // `[]` as "none" and agentEntry writes each eligible profile's bundled skills.
  // Workspace skill folders would load model-written text as instructions.
  config.agents.defaults = { ...config.agents.defaults, skills: [] };
  // Reserve room for parent conversations as well as the host's member slots.
  config.agents.defaults.maxConcurrent = enabled ? teams.hostMaxConcurrent + 8 : 8;
  // Warnings only: routine records can carry conversation context. OpenClaw rotates
  // its own file at the same 10 MiB bound AgentPier applies to the console log.
  config.logging = {
    ...config.logging,
    file: path.join(paths.logs, "openclaw.log"),
    level: "warn",
    consoleLevel: "warn",
    maxFileBytes: 10 * 1024 * 1024,
  };
  // Never export or trace prompt and tool content.
  config.diagnostics = {
    ...config.diagnostics,
    flags: [],
    otel: { ...config.diagnostics?.otel, enabled: false, captureContent: false },
    cacheTrace: { enabled: false },
  };
  config.gateway = {
    ...config.gateway,
    mode: "local",
    bind: "loopback",
    port,
    auth: { mode: "token", token },
    controlUi: { enabled: false },
    // OpenClaw enables an operator terminal by default: a host shell for admin clients.
    terminal: { enabled: false },
    tailscale: { mode: "off" },
    reload: { mode: "hybrid" },
    // Loopback WSS with an AgentPier-issued certificate the client pins.
    ...(tls && {
      tls: {
        enabled: true,
        autoGenerate: false,
        certPath: tls.certPath,
        keyPath: tls.keyPath,
      },
    }),
  };
  return config;
}

export function prepareRuntimeConfig(
  paths,
  port,
  teams,
  {
    maintenance = false,
    tls,
    overrides = [],
    webTools,
    shell,
    mcp,
    telegram,
    // Read from disk by the caller (runtime-supervisor.js, skill-shadows.js). This
    // module stays free of third-party imports: the installer's dependency checks
    // load it through runtime-install.js before node_modules exists.
    skillShadows,
  } = {},
) {
  const existing = readJSON(paths.config, null);
  const token = existing?.gateway?.auth?.token || randomBytes(32).toString("hex");
  writePrivate(
    paths.config,
    compileOpenClawConfig({
      existing,
      paths,
      port,
      token,
      teams,
      overrides,
      runtime: { maintenance },
      tls,
      webTools,
      shell,
      mcp,
      telegram,
      skillShadows,
    }),
  );
  return token;
}

/**
 * The Gateway's `PATH`: the runtime's own Node first, then the owner's login PATH
 * that exec already receives as `tools.exec.pathPrepend` (exec-shell.js), then the
 * system directories. OpenClaw checks a skill's required programs on this PATH, so
 * without the owner's directories Homebrew tools such as `gh` count as missing and
 * the skill does not load. Absolute directories only, without duplicates, path
 * delimiters or NUL characters.
 */
export function gatewayPath(nodePath, pathPrepend = []) {
  const directories = [];
  for (const directory of [path.dirname(nodePath), ...pathPrepend, "/usr/bin", "/bin"])
    if (
      path.isAbsolute(directory) &&
      !directory.includes(path.delimiter) &&
      !directory.includes("\0") &&
      !directories.includes(directory)
    )
      directories.push(directory);
  return directories.join(path.delimiter);
}

/**
 * The Gateway's process environment. `shell` is the exec shell wrapper
 * (exec-shell.js) and `pathPrepend` the owner's login PATH (see gatewayPath); exec
 * children inherit this environment, so the Gateway token is not in it: the Gateway
 * reads it from gateway.auth.token and AgentPier's client holds its own copy.
 */
export function runtimeEnvironment(
  paths,
  nodePath,
  parent = process.env,
  { shell, pathPrepend } = {},
) {
  return {
    ...proxyEnvironment(parent),
    PATH: gatewayPath(nodePath, pathPrepend),
    HOME: paths.home,
    TMPDIR: paths.tmp,
    LANG: "en_US.UTF-8",
    OPENCLAW_STATE_DIR: paths.state,
    OPENCLAW_CONFIG_PATH: paths.config,
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    DO_NOT_TRACK: "1",
    // A test run's marker (scripts/test-runner.mjs): its sweep finds a Gateway that
    // outlived its test. Never set outside test runs.
    ...(parent.AGENTPIER_TEST_RUN && { AGENTPIER_TEST_RUN: parent.AGENTPIER_TEST_RUN }),
    ...(shell && { SHELL: shell }),
    // A visible agent browser opens on the owner's display; without one OpenClaw
    // launches it headless (browser-detection.js hasDisplay).
    ...displayEnvironment(parent),
  };
}
const displayVariables = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"];
/** The display variables of `parent` that are set, for the Gateway's browsers. */
export const displayEnvironment = (parent = process.env) =>
  Object.fromEntries(
    displayVariables
      .filter((name) => typeof parent[name] === "string" && parent[name])
      .map((name) => [name, parent[name]]),
  );
export { proxyEnvironment, proxyVariables } from "../../lib/proxy-environment.js";
