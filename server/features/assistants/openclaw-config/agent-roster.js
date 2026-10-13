import { setTimeout as delay } from "node:timers/promises";
import { assistantProblem } from "../assistant-validation.js";

// OpenClaw 2026.9.8 answers agents.create once the profile is persisted; agents.list
// reads the runtime config, which picks the agent up only after the Gateway's plugin
// reload. Meanwhile the roster call answers UNAVAILABLE or omits the agent. The
// Gateway announces no event for that reload (`config.changed` covers config
// writes, is dropped for slow clients and is not sent for every reload), so the
// roster is read until a deadline. A busy host has needed more than 5 s for the
// reload; 30 s leaves room for slow machines and still ends a stuck reload clearly.
export const agentRosterTimeoutMs = 30000;
const firstPollMs = 100;
const lastPollMs = 1000;

/**
 * Resolves once the Gateway lists `agentId`. An UNAVAILABLE answer from the Gateway
 * (its reload) is read again; a local failure (lost connection, call timeout) fails
 * at once. After `timeoutMs` it fails with `agentLoading` (503).
 */
export async function waitForAgentInRoster(
  client,
  agentId,
  {
    timeoutMs = agentRosterTimeoutMs,
    now = Date.now,
    sleep = delay,
    warn = console.warn,
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (let pause = firstPollMs; ; pause = Math.min(lastPollMs, pause * 2)) {
    const roster = await client.call("agents.list", {}).catch((error) => {
      if (error.code === "UNAVAILABLE" && error.answered) return {};
      throw error;
    });
    if (roster.agents?.some((agent) => agent.id === agentId)) return;
    const left = deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(pause, left));
  }
  warn(`Assistant Gateway did not list a newly configured agent within ${timeoutMs} ms.`);
  throw assistantProblem("agentLoading", 503);
}
