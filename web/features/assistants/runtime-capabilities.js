import { capabilityGateCopy } from "../../lib/i18n/messages/components.js";
import { traitOf } from "./runtime-traits.js";

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

/**
 * The product name of the agent's runtime, as its settings show it: the name its view
 * carries (`runtimeInfo`, which every agent the server lists has). A missing view (an
 * agent not loaded yet) is named by the default runtime of the runtime list
 * `runtimes` where the caller has one, else in neutral words ("The agent's runtime").
 */
export const runtimeName = (assistant, runtimes) =>
  assistant?.runtimeInfo?.name ||
  runtimes?.[0]?.name ||
  capabilityGateCopy.unknownRuntime;

/** "OpenClaw 2026.10.3", or the name alone while its version is unknown. */
export const runtimeLabel = (assistant, runtimes) =>
  [runtimeName(assistant, runtimes), assistant?.runtimeInfo?.version]
    .filter(Boolean)
    .join(" ");

// Whether a runtime (its view, `runtimeInfo`) reaches only a ChatGPT login AgentPier
// holds, through its model proxy (trait `models.chatgptLogin`; Hermes).
const needsHeldLogin = (runtimeInfo) =>
  traitOf(runtimeInfo, "models", "chatgptLogin") === "agentpierHeld";

/**
 * The model connections an agent on the runtime `runtimeInfo` shows may choose from
 * `models`: a runtime that needs a login AgentPier holds lists ChatGPT logins
 * OpenClaw still holds unavailable (`runtimeAccount`; server own-process-agents.js
 * refuseModelChoice).
 */
export const modelsFor = (models, runtimeInfo) =>
  needsHeldLogin(runtimeInfo)
    ? models.map((m) =>
        m.providerId === "openai-chatgpt" && m.holder !== "agentpier"
          ? { ...m, available: false, reason: "runtimeAccount" }
          : m,
      )
    : models;

/**
 * Whether an agent on the runtime `runtimeInfo` shows can create images with
 * `models`: AgentPier creates them through a signed-in ChatGPT login (server
 * model-accounts.js), its last known status counting also while the service is away.
 * A runtime that needs a login AgentPier holds reaches only such a one (server
 * hermes-config/images.js). "ready", "move" (only logins OpenClaw holds are signed
 * in) or "none".
 */
export function imagesFor(models, runtimeInfo) {
  const signedIn = models.filter(
    (m) => m.providerId === "openai-chatgpt" && (m.signedIn ?? m.available) === true,
  );
  if (!needsHeldLogin(runtimeInfo)) return signedIn.length ? "ready" : "none";
  if (signedIn.some((m) => m.holder === "agentpier")) return "ready";
  return signedIn.length ? "move" : "none";
}
