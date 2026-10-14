import path from "node:path";
import { randomBytes } from "node:crypto";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { guardedTools, memoryTools } from "./native-capabilities.js";
import { agentEntry } from "./openclaw-config/agent-entry.js";
import { hardenedDefaults } from "./openclaw-config/locked-core.js";
import { applyOverrides } from "./openclaw-config/overrides.js";
import { applyShell, shellSections, withoutShell } from "./openclaw-config/shell.js";
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
      list: [{ id: "main", default: true }],
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
  const config = applyOverrides(existing || freshDefaults(paths), overrides);
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
              // The plugin classifies absolute write targets below this root.
              config: { ...teams.connection, workspaces: paths.workspaces },
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
  });
  if (enabled && teams.native) {
    // memory and skills.workshop are written only here; otherwise they stay inert
    // (memory slot "none", cron off).
    config.plugins.slots.memory = "memory-core";
    config.plugins.allow.push("memory-core");
    config.plugins.entries["memory-core"] = {
      enabled: true,
      config: { dreaming: { enabled: false } },
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
      // A fresh Gateway has not proven its write guard yet; no profile keeps writes.
      if (Array.isArray(entry.tools?.allow))
        entry.tools.allow = entry.tools.allow.filter((t) => !guardedTools.includes(t));
      const profile = teams.profiles?.find((a) => a.runtimeAgentId === (entry.id || key));
      if (!profile) continue;
      Object.assign(
        entry,
        agentEntry(entry, profile, {
          teamsReady: true,
          nativeReady: true,
          guardProven: false,
          available,
          pathPrepend: shell?.pathPrepend,
          mcpTools: mcpServers.agentTools[profile.runtimeAgentId],
          senderFacing: !!telegramCompiled.accounts[profile.runtimeAgentId],
          shadowedSkills: skillShadows[profile.runtimeAgentId],
        }),
      );
    }
  }
  // Only the native team start compiles the agents' own bots; any other start, and
  // every start without bots, removes what an earlier one wrote.
  applyTelegram(config, telegramCompiled);
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
    ...(shell && { SHELL: shell }),
  };
}
export { proxyEnvironment, proxyVariables } from "../../lib/proxy-environment.js";
