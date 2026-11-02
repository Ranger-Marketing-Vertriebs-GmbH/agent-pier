// What the agent settings need of the agent's runtime (ADR 0006): each surface names
// the capability of its sub-port (server runtimes/agent-runtime.js). A capability the
// runtime lacks keeps the surface visible, disabled with the reason (CapabilityGate).
export const surfaceCapabilities = Object.freeze({
  shell: "approvals",
  allowlist: "approvals",
  routines: "routines",
  skills: "skills",
  browser: "browser",
  mcp: "config",
  memory: "agentFiles",
  models: "models",
  channels: "channels",
  // An agent's own Telegram bot for other people, which the runtime runs itself.
  telegramSenders: "channelBots",
});

// Every agent ran on OpenClaw before agents named their runtime (server DEFAULT_RUNTIME).
const defaultRuntimeName = "OpenClaw";
// The product names of the runtimes a new agent may choose (server runtimes/).
const runtimeNames = Object.freeze({
  openclaw: defaultRuntimeName,
  hermes: "Hermes Agent",
});

/** The product name of runtime id `id`; "" (the server's default) is OpenClaw. */
export const runtimeIdName = (id) =>
  Object.hasOwn(runtimeNames, id || "openclaw") ? runtimeNames[id || "openclaw"] : id;

/** The product name of the agent's runtime, as its settings show it. */
export const runtimeName = (assistant) =>
  assistant?.runtimeInfo?.name || defaultRuntimeName;

/** "OpenClaw 2026.10.3", or the name alone while its version is unknown. */
export const runtimeLabel = (assistant) =>
  [runtimeName(assistant), assistant?.runtimeInfo?.version].filter(Boolean).join(" ");

/**
 * The model connections an agent of runtime `runtimeId` may choose from `models`:
 * a Hermes agent lists ChatGPT logins OpenClaw still holds unavailable
 * (`runtimeAccount`): only a login AgentPier holds reaches Hermes, through its model
 * proxy (server own-process-agents.js refuseModelChoice).
 */
export const modelsFor = (models, runtimeId) =>
  runtimeId === "hermes"
    ? models.map((m) =>
        m.providerId === "openai-chatgpt" && m.holder !== "agentpier"
          ? { ...m, available: false, reason: "runtimeAccount" }
          : m,
      )
    : models;

/**
 * Whether the agent can create images with `models`: AgentPier creates them through a
 * signed-in ChatGPT login (server model-accounts.js), its last known status counting
 * also while the service is away. A Hermes agent reaches only a login AgentPier holds,
 * through its model proxy (server hermes-config/images.js). "ready", "move" (only
 * logins OpenClaw holds are signed in) or "none".
 */
export function imagesFor(models, assistant) {
  const signedIn = models.filter(
    (m) => m.providerId === "openai-chatgpt" && (m.signedIn ?? m.available) === true,
  );
  if (assistant?.runtimeInfo?.id !== "hermes") return signedIn.length ? "ready" : "none";
  if (signedIn.some((m) => m.holder === "agentpier")) return "ready";
  return signedIn.length ? "move" : "none";
}
