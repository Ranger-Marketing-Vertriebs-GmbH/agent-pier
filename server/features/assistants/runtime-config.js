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
  applyWebTools,
  webToolsAvailability,
  webToolsSections,
} from "./openclaw-config/web-tools.js";

export const teamTools = [
  "session_status",
  "agentpier_team_propose",
  "agentpier_team_status",
  "agentpier_team_stop",
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
          allow: ["agentpier-teams"],
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
        }),
      );
    }
  }
  config.cron = { ...config.cron, enabled: !!(enabled && teams.native && !maintenance) };
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
  { maintenance = false, tls, overrides = [], webTools, shell, mcp } = {},
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
    }),
  );
  return token;
}

/**
 * The Gateway's process environment. `shell` is the exec shell wrapper
 * (exec-shell.js); exec children inherit this environment, so the Gateway token is
 * not in it: the Gateway reads it from gateway.auth.token and AgentPier's client
 * holds its own copy.
 */
export function runtimeEnvironment(
  paths,
  nodePath,
  parent = process.env,
  { shell } = {},
) {
  return {
    ...proxyEnvironment(parent),
    PATH: `${path.dirname(nodePath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
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
