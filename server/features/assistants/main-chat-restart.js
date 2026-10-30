import { assistantProblem } from "./assistant-validation.js";
import { mainConversation } from "./routine-targets.js";
import { restartScope, runningWork } from "./restart-work.js";

/**
 * What restarting the agent's main chat would affect: the persons with a main chat,
 * the members that restart with it and the work it stops. Refuses a team member and an
 * archived agent.
 */
export function restartPreview(service, assistantId) {
  const agent = service.store.getAssistant(assistantId);
  if (agent.teamMemberId) throw assistantProblem("invalid");
  if (agent.archivedAt) throw assistantProblem("active", 409);
  const persons = new Set(
    service.store
      .listConversations()
      .filter(
        (c) =>
          c.assistantId === assistantId && c.channel === "agentpier" && !c.archivedAt,
      )
      .map((c) => c.userId ?? null),
  );
  const people = [...persons].filter((userId) =>
    mainConversation(service.store, assistantId, userId),
  ).length;
  const { permanent, temporary } = restartScope(service, assistantId);
  return {
    people,
    members: { temporary: temporary.length, permanent: permanent.length },
    work: runningWork(service, assistantId),
  };
}
