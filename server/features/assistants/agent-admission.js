import { runtimeFor } from "./runtimes/runtime-for.js";

// Which agents the running runtime admitted, through the agents sub-port of the
// runtime port. OpenClaw admits agents in the background after an unclean stop and
// refuses some for the Gateway's lifetime (runtimes/openclaw/agent-admission.js).

// The agents sub-port behind the runtime supervisor `runtime`, or null without one.
const agentsOf = (runtime) =>
  runtime && typeof runtime === "object" ? runtimeFor(null, runtime).agents : null;

/** Whether the runtime behind the supervisor `runtime` refused `runtimeAgentId`. */
export const agentDegradedOn = (runtime, runtimeAgentId) =>
  !!agentsOf(runtime)?.degraded().has(runtimeAgentId);

/** Records the admission refusal `error` reported; returns it, or null. */
export const noteRefusalOn = (runtime, error) => {
  const agents = agentsOf(runtime);
  return agents ? agents.noteRefusal({ error }) : (error?.admissionRefusal ?? null);
};

/** Whether `refusal` only says the runtime still admits the agent (agents.admitting). */
export const admittingOn = (runtime, refusal) => !!agentsOf(runtime)?.admitting(refusal);

/** Resolves once the runtime admitted or refused its agents (agents.admitted). */
export const admissionDoneOn = (runtime) =>
  agentsOf(runtime)?.admitted() ?? Promise.resolve();

/**
 * The owner's list (assistant-service.js list): an agent the running Gateway refused
 * is `degraded`, and its chats show AGENT_DEGRADED before any session fault
 * (chat-reconcile.js `sessionFailures`).
 */
export function withAdmission(service, { assistants, conversations }) {
  const refused = agentsOf(service.runtime)?.degraded() || new Set();
  const degraded = new Set(
    assistants.filter((a) => refused.has(a.runtimeAgentId)).map((a) => a.id),
  );
  return {
    assistants: assistants.map((a) =>
      degraded.has(a.id) ? { ...a, degraded: true } : a,
    ),
    conversations: conversations.map((c) => {
      const diagnostic = degraded.has(c.assistantId)
        ? "AGENT_DEGRADED"
        : service.sessionFailures?.get(c.id)?.diagnostic;
      return diagnostic ? { ...c, diagnostic } : c;
    }),
  };
}
