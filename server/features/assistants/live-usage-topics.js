// The live usage topics, owner only (agent-usage.js); each one's value is what its
// REST route answers:
// - `agent.usage:<agentId>`: GET /api/assistants/:id/usage, the agent's tokens and
//   cost today and over 7 and 30 days;
// - `agent.chat-usage:<conversationId>`: GET /api/assistant-conversations/:id/usage,
//   one chat's tokens, cost and context fill.
// A run that ended in a chat of the agent signals both (agentUsageChanged, from
// gateway-wiring.js), so the figures follow each finished turn. What ends outside a
// chat (a routine's own session, the agent's bot) shows with the next read: reads
// are kept for a minute (agent-usage.js usageCacheMs). While the runtime was still
// computing its report (`pending`) a topic is sampled every 2 s, visible tabs only.
// The agent topic is content like its route (a user's own agent only under her
// opt-in); the chat topic refuses a user's chat itself (AgentUsage#chat).
import { detailTopic } from "./live-topics.js";
import { followAgentSwitch, notRunning } from "./live-runtime-topics.js";
import { sharedSource } from "../live/shared-source.js";
import { usageOf } from "./agent-usage.js";

/** How often figures the runtime still computes are read again. */
export const USAGE_PENDING_SAMPLE_MS = 2000;

function usage(services) {
  const assistants = services.assistants;
  if (!assistants) throw notRunning(Boolean(services.assistantFeature?.enabled));
  return usageOf(assistants);
}

/** The usage topic definitions for LiveHub#define. */
export function agentUsageTopics(services) {
  const switched = sharedSource((fanout) => followAgentSwitch(services, fanout));
  const pending = {
    watch: switched,
    sampleMs: USAGE_PENDING_SAMPLE_MS,
    sampleWhile: (value) => value?.pending === true,
  };
  return [
    detailTopic(services, {
      name: "agent.usage",
      content: true,
      read: (id) => usage(services).agent(id),
      ...pending,
    }),
    detailTopic(services, {
      name: "agent.chat-usage",
      read: (id) => usage(services).chat(id),
      ...pending,
    }),
  ];
}

/**
 * A run of `conversation` ended: forgets the kept figures of the chat and its agent
 * (`usage`, the AgentUsage) and signals their topics on `hub` (services.live). A
 * failing hub is logged.
 */
export function agentUsageChanged(hub, usage, conversation) {
  try {
    usage?.changed(conversation);
    hub?.invalidate("agent.usage", conversation.assistantId);
    hub?.invalidate("agent.chat-usage", conversation.id);
  } catch {
    console.error("AgentPier could not report a change of an agent's usage.");
  }
}
