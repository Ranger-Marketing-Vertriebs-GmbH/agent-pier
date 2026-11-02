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
 * Whether the agent's runtime cannot create images: AgentPier creates them through a
 * ChatGPT account, whose sign-in Hermes agents cannot use (modelsFor).
 */
export const runtimeLacksImages = (assistant) => assistant?.runtimeInfo?.id === "hermes";
