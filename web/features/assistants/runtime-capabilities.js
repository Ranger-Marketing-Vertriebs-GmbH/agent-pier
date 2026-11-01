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
