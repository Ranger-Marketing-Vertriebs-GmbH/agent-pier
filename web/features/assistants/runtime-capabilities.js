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

/** The product name of the agent's runtime, as its settings show it. */
export const runtimeName = (assistant) =>
  assistant?.runtimeInfo?.name || defaultRuntimeName;

/** "OpenClaw 2026.10.3", or the name alone while its version is unknown. */
export const runtimeLabel = (assistant) =>
  [runtimeName(assistant), assistant?.runtimeInfo?.version].filter(Boolean).join(" ");
