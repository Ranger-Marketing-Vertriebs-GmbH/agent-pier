import path from "node:path";
import { randomBytes } from "node:crypto";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import {
  guardedTools,
  memoryTools,
  personalCapabilities,
  profileTools,
} from "./native-capabilities.js";

export const teamTools = [
  "session_status",
  "agentpier_team_propose",
  "agentpier_team_status",
  "agentpier_team_stop",
];

export function prepareRuntimeConfig(
  paths,
  port,
  teams,
  { maintenance = false, tls } = {},
) {
  const existing = readJSON(paths.config, null);
  const token = existing?.gateway?.auth?.token || randomBytes(32).toString("hex");
  const config = existing || {
    agents: {
      defaults: {
        workspace: paths.workspaces,
        skipBootstrap: true,
        heartbeat: { every: "0m" },
      },
      list: [{ id: "main", default: true }],
    },
    channels: {},
    browser: { enabled: false },
    cron: { enabled: false },
    plugins: { slots: { memory: "none" } },
    skills: { allowBundled: [] },
    tools: { allow: ["session_status"] },
    discovery: { mdns: { mode: "off" } },
    telemetry: { enabled: false },
    update: { checkOnStart: false, auto: { enabled: false } },
  };
  // Paths are this installation's; a restored or copied configuration cannot pick them.
  config.agents = {
    ...config.agents,
    defaults: { ...config.agents?.defaults, workspace: paths.workspaces },
  };
  const enabled = !!(teams?.directory && teams?.connection);
  config.tools = { allow: enabled ? teamTools : ["session_status"], toolSearch: false };
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
    config.tools.allow = [
      ...teamTools,
      ...memoryTools,
      "agentpier_reminder",
      "agentpier_routine",
      "agentpier_workspace",
    ];
    config.tools.fs = { workspaceOnly: true };
    config.cron = {
      enabled: true,
      webhookToken: teams.native.token,
      webhookSsrfPolicy: { allowedHostnames: ["127.0.0.1"] },
    };
    const entries = config.agents.entries || config.agents.list;
    for (const [key, entry] of Object.entries(entries || {})) {
      delete entry.skills;
      // A fresh Gateway has not proven its write guard yet; no profile keeps writes.
      if (Array.isArray(entry.tools?.allow))
        entry.tools.allow = entry.tools.allow.filter((t) => !guardedTools.includes(t));
      const profile = teams.profiles?.find((a) => a.runtimeAgentId === (entry.id || key));
      if (!profile) continue;
      entry.tools = { allow: profileTools(profile, true, true, false) };
      entry.memory = {
        search: {
          enabled: personalCapabilities(profile).memory,
          rememberAcrossConversations: false,
        },
      };
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
  writePrivate(paths.config, config);
  return token;
}
export function runtimeEnvironment(paths, nodePath, token, parent = process.env) {
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
    OPENCLAW_GATEWAY_TOKEN: token,
  };
}
export { proxyEnvironment, proxyVariables } from "../../lib/proxy-environment.js";
