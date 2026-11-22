import { atLeast, isCliVersion } from "../../../../tools/cli-version-compare.js";
import { telegramSurfaces } from "./telegram-senders.js";

// Paths AgentPier owns. A later capability step moves a path out of this list
// together with its safety rule. `tools`, `browser` and `plugins` also carry what
// the agents' web capabilities need (openclaw-config/web-tools.js); that content
// comes from the profiles and detected availability, never from overrides. `mcp`
// (MCP servers can run host commands over stdio), `secrets` (credential providers) and
// `env` (variables for the Gateway and its tools) stay out of reach of overrides; the
// compiler owns `mcp` and removes any block it did not write. The channel surfaces
// (`channels`, `bindings`, `session`, `commands`, `approvals`, `accessGroups`) and the
// Deepgram key belong to the agents' own Telegram bots (openclaw-config/
// telegram-senders.js): an override could otherwise admit senders or route them.
export const lockedPaths = [
  "gateway",
  "update",
  "discovery",
  "telemetry",
  "diagnostics",
  "logging",
  "plugins",
  "tools",
  "cron",
  "channels",
  "browser",
  "memory",
  "skills.allowBundled",
  "skills.load",
  "skills.workshop",
  "agents.defaults.workspace",
  "agents.defaults.skills",
  "agents.defaults.maxConcurrent",
  // Off on 2026.11.3, retired by 2026.11.6 (heartbeatDefault below).
  "agents.defaults.heartbeat",
  // The owner's PDF fallback or a placeholder (pdf-model-settings.js); compiled per start.
  "agents.defaults.pdfModel",
  "agents.entries",
  "agents.list",
  "mcp",
  "secrets",
  "env",
  ...telegramSurfaces,
  "models.providers.deepgram",
];

export function isLockedPath(target) {
  return lockedPaths.some(
    (locked) =>
      target === "" ||
      target === locked ||
      target.startsWith(`${locked}.`) ||
      locked.startsWith(`${target}.`),
  );
}

/**
 * OpenClaw's heartbeat monitor: 2026.11.3 runs it every 30 minutes unless
 * `agents.defaults.heartbeat.every` is "0m" (AgentPier runs its own check-ins as
 * routines, native-heartbeats.js); 2026.11.6 retired it and refuses to start while
 * the key is set. The defaults' value for `version`, or undefined to remove it; no
 * (or no release) version means the pinned runtime.
 */
export function heartbeatDefault(version) {
  return isCliVersion(version) && !atLeast(version, "2026.11.6")
    ? { every: "0m" }
    : undefined;
}

// Written on every start, not only into a fresh file.
export function hardenedDefaults() {
  return {
    channels: {},
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    telemetry: { enabled: false },
    update: { checkOnStart: false, auto: { enabled: false } },
  };
}
