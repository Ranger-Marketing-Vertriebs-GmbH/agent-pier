import { assistantProblem, textValue } from "./assistant-validation.js";
import { personalShell } from "./native-capabilities.js";
import {
  hostReady,
  routineRunOf,
  runtimeFor,
  runtimeIdOf,
} from "./runtimes/runtime-for.js";

// Why the owner's question for a routine run did not allow it, for the model.
export const routineApprovalRefusals = Object.freeze({
  denied: "BLOCKED: the owner denied this command. Find another way without it.",
  unanswered:
    "BLOCKED: the owner did not answer in time, or AgentPier could not ask. Do not retry this command in this run.",
});

const keys = ["agentId", "sessionKey", "command", "description", "kind"];
const kinds = ["command", "code", "input", "write"];
const deny = (message) => ({ allow: false, message });

/**
 * The AgentPier guard plugin's question in a Hermes routine or hook run
 * (runtimes/hermes/hermes-config/guard-plugin.js): Hermes clears every approval
 * surface in a cron run (tools/approval.py _presence), so the plugin asks here and
 * waits. Only a running routine's or hook's run session of the calling agent asks;
 * the question goes through the agent's approvals sub-port (approvals.ask), which
 * publishes it like Hermes's own requests, so exec-approvals.js shows it in the
 * routine's chat and its Telegram chat. Answers `{ allow }`, or `{ allow: false,
 * message }` for the model: any doubt refuses.
 */
export async function hermesRoutineApproval(bridge, input) {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((k) => !keys.includes(k)) ||
    !kinds.includes(input.kind)
  )
    throw assistantProblem("invalid");
  textValue(input.agentId, 512);
  textValue(input.sessionKey, 4096);
  textValue(input.command, 65536);
  if (input.description !== undefined && typeof input.description !== "string")
    throw assistantProblem("invalid");
  const agent = bridge.agentOf(input.agentId);
  if (
    bridge.closed ||
    !agent ||
    agent.archivedAt ||
    runtimeIdOf(agent) !== "hermes" ||
    personalShell(agent) === "off" ||
    !hostReady(bridge.assistants.runtime, agent)
  )
    return deny(routineApprovalRefusals.unanswered);
  const run = routineRunOf(agent, input.sessionKey);
  const routines = bridge.assistants.routines;
  if (
    !run?.runId ||
    run.agentId.toLowerCase() !== agent.runtimeAgentId.toLowerCase() ||
    !(
      routines?.runOrigin(agent, input.sessionKey) ||
      routines?.hooks?.runOrigin(agent, input.sessionKey)
    )
  )
    return deny(routineApprovalRefusals.unanswered);
  const { approvals } = runtimeFor(agent, bridge.assistants.runtime);
  if (typeof approvals.ask !== "function")
    return deny(routineApprovalRefusals.unanswered);
  let decision = null;
  try {
    decision = await approvals.ask({
      sessionKey: input.sessionKey,
      command: input.command,
      description: input.description || "",
    });
  } catch {
    decision = null;
  }
  if (decision === "allow-once") return { allow: true };
  return deny(
    decision === "deny"
      ? routineApprovalRefusals.denied
      : routineApprovalRefusals.unanswered,
  );
}
