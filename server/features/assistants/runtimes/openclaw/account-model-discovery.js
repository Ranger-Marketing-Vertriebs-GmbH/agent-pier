import { setTimeout as delay } from "node:timers/promises";
import { settledAdmission } from "./agent-admission.js";

// The models a ChatGPT account's discovery lists (`/codex/models`, such as
// GPT-6.2-Astra) are no bundled catalog row: OpenClaw knows their ChatGPT route only
// from that discovery. OpenClaw 2026.11.6 keeps the result per agent, does not run it
// for a turn, and its Doctor drops what 2026.11.3 kept when it migrates the agent
// databases. Until an agent's own discovery ran, a turn on such a model fails in
// milliseconds: "Unknown model", or, when OpenClaw's model catalog names the model,
// "No route-compatible authentication source is configured for openai" (only its
// API-key route is known). AGENTPIER-487.

// An agent pinned to an account's login: `openai/<model>@<profile>` (model-accounts.js).
const accountRef = /^openai\/[^@\s]+@\S+$/;
const refOf = (model) => (typeof model === "string" ? model : model?.primary);
// One discovery waits at most this long for OpenClaw's background discovery; a read
// answers after OpenClaw's five-second foreground wait (model-account-catalog.js).
const budgetMs = 60_000;
const callTimeoutMs = 30_000;

/** Whether an agent's `model` (a ref, or `{ primary }`) runs on an account's login. */
export const onAccountLogin = (model) => accountRef.test(refOf(model) ?? "");

/** The runtime agent ids whose model runs on a ChatGPT account's login. */
export function accountAgentIds(config) {
  const agents = config?.agents;
  const entries = agents?.entries
    ? Object.entries(agents.entries).map(([id, entry]) => ({ ...entry, id }))
    : Array.isArray(agents?.list)
      ? agents.list
      : [];
  return entries
    .filter((entry) => typeof entry?.id === "string")
    .filter((entry) => onAccountLogin(entry.model))
    .map((entry) => entry.id);
}

/**
 * Runs the openai model discovery of each of `agentIds` on `client` once the Gateway
 * admitted its agents: a refreshed `models.list`, read again while discovery is still
 * pending. Never rejects; a failed agent is left to its next start or apply.
 */
export async function discoverAccountModels(
  client,
  agentIds,
  { now = Date.now, budget = budgetMs, pauseMs = 1000 } = {},
) {
  if (!client || !agentIds.length) return;
  await settledAdmission(client).catch(() => {});
  for (const agentId of agentIds) {
    const deadline = now() + budget;
    try {
      for (;;) {
        const result = await client.call(
          "models.list",
          { agentId, provider: "openai", view: "all", refresh: true },
          { timeoutMs: callTimeoutMs },
        );
        const pending = result?.pendingProviders?.includes?.("openai");
        if (!pending || now() >= deadline) break;
        await delay(pauseMs);
      }
    } catch {
      // The Gateway went away or refused the read: the next start discovers again.
    }
  }
}
