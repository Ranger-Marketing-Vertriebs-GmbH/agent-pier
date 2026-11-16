// Agents that run in a process set of their own (Hermes Agent, ADR 0006 decision 4)
// beside the shared OpenClaw host, as AssistantService follows them: what a create or
// update may choose, and the status and run events of each set.
import { assistantProblem } from "./assistant-validation.js";
import { AgentQuestions } from "./agent-questions.js";
import {
  agentRuntimeEvents,
  assertRuntimeReady,
  onAgentHostStatus,
  traitOf,
} from "./runtimes/runtime-for.js";

// Whether the agent's runtime has the shell level that asks before every command.
const offersEveryCommand = (agent) =>
  traitOf(agent, "approvals", "shellLevels").includes("every");

/**
 * Refuses a new agent's runtime choice this AgentPier cannot run now: an agent of a
 * runtime that is not enabled and installed (runtime-for.js assertRuntimeReady: 409
 * with the runtime's own refusal, for Hermes `hermesUnavailable`), and "Every
 * command" on a runtime without it (shellEveryCommandUnsupported, 400).
 */
export function refuseRuntimeChoice(supervisor, input, accounts) {
  assertRuntimeReady(supervisor, input);
  if (input.shellEveryCommand === true && !offersEveryCommand(input))
    throw assistantProblem("shellEveryCommandUnsupported", 400);
  refuseModelChoice(input, input.model, accounts);
}

/**
 * Refuses a ChatGPT login OpenClaw still holds (connection ids `openclaw:…`,
 * model-accounts.js holder "openclaw") as the model of an own-process agent
 * (modelAccountRuntime, 400): only a login AgentPier holds is reachable through its
 * model proxy (runtimes/hermes/hermes-config/model.js); OpenClaw's own refresh token
 * is never shared.
 */
export function refuseModelChoice(agent, model, accounts) {
  if (
    traitOf(agent, "models", "chatgptLogin") === "agentpierHeld" &&
    typeof model?.connectionId === "string" &&
    model.connectionId.startsWith("openclaw:") &&
    accounts?.holderOf(model.connectionId) !== "agentpier"
  )
    throw assistantProblem("modelAccountRuntime", 400);
}

/**
 * Refuses what an update of `agent` chooses that its runtime cannot run: "Every
 * command" where the runtime does not offer it (400), and a model it cannot use
 * (refuseModelChoice).
 */
export function refuseEveryCommand(supervisor, agent, changes, accounts) {
  if (changes.shellEveryCommand === true && !offersEveryCommand(agent))
    throw assistantProblem("shellEveryCommandUnsupported", 400);
  refuseModelChoice(agent, changes.model, accounts);
}

/**
 * Follows every own-process agent of `service`: a status change of its set refreshes
 * the agents list, and its run events reach `onEvent` (the chat path and the event
 * hub), subscribed once and kept across the set's restarts; the questions its agents
 * ask in their chats become `service.questions` (agent-questions.js). Returns
 * unsubscribe.
 */
export function followOwnProcesses(service, onEvent) {
  service.questions = new AgentQuestions(service);
  const changed = () => !service.closed && service.changed();
  const unfollow = onAgentHostStatus(service.runtime, changed);
  const unsubscribe = agentRuntimeEvents(service.runtime).subscribe(onEvent);
  return () => {
    unfollow();
    unsubscribe();
  };
}
