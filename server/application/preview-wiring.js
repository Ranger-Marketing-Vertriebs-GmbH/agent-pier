import fs from "node:fs";
import path from "node:path";
import { PreviewService } from "../features/previews/preview-service.js";
import { activeSessionGrant } from "../features/mcp/session-capability.js";
import { lastCdpOffset } from "../features/assistants/openclaw-config/browser-profiles.js";
import { readJSON } from "../lib/storage.js";

const read = (file) => {
  try {
    return readJSON(file, null);
  } catch {
    return null;
  }
};
const portOf = (url) => {
  try {
    return Number(new URL(url).port) || null;
  } catch {
    return null;
  }
};

/** The loopback ports of running sessions' protocol adapters (adapter-supervisor.js). */
function adapterPorts(directory) {
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".adapter-port.json"))
    .map((name) => path.join(directory, name))
    .filter((file) => {
      const record = read(file.replace(/\.adapter-port\.json$/, ".json"));
      return record?.status === "running";
    })
    .map((file) => read(file)?.port);
}

/**
 * AgentPier's own listeners a preview may never forward to: its HTTP port, the team
 * bridge, the Gateway with the agent browsers' CDP ports, and the session adapters.
 */
export function internalPorts(services) {
  const ports = new Set();
  const add = (port) => Number.isInteger(port) && port > 0 && ports.add(port);
  add(services.effectiveConfig?.().port ?? services.config?.port);
  add(portOf(services.assistantTeams?.bridge?.connection?.url));
  const runtime = services.assistantRuntime;
  const gateway = portOf(runtime?.client?.url) ?? runtime?.webTools?.port;
  if (gateway) {
    add(gateway);
    // OpenClaw's CDP ports: gateway + 11 up to + lastCdpOffset (web-tools.js).
    for (let offset = 11; offset <= lastCdpOffset; offset++) add(gateway + offset);
  }
  for (const profile of Object.values(runtime?.webTools?.browserProfiles || {}))
    add(profile?.cdpPort);
  for (const entry of services.assistants?.browsers?.running?.values() || [])
    add(entry?.keeper?.cdpPort);
  for (const port of adapterPorts(services.sessions?.directory)) add(port);
  return ports;
}

/** An agent preview's owner: the conversation exists and its agent is not archived. */
export function agentAlive(services, { assistantId, conversationId }) {
  const store = services.assistants?.store;
  if (!store) return false;
  try {
    const conversation = store.getConversation(conversationId);
    if (conversation.assistantId !== assistantId) return false;
    return !store.getAssistant(assistantId).archivedAt;
  } catch {
    return false;
  }
}

/** The PreviewService on `services`; everything it reads is looked up lazily. */
export function createPreviewService(services, overrides = {}) {
  const { config } = services;
  return new PreviewService({
    dataDir: config.dataDir,
    effective: () => services.effectiveConfig?.() ?? config,
    bindHost: () => services.networkState?.bind || "127.0.0.1",
    detected: () => services.networkState?.detected,
    identity: () => services.identity,
    audit: services.audit,
    live: () => services.live,
    sessionAlive: (id) => activeSessionGrant(config.dataDir, id) !== null,
    agentAlive: (owner) => agentAlive(services, owner),
    internalPorts: () => internalPorts(services),
    tailscaleRun: config.tailscaleRun,
    ...overrides,
  });
}
