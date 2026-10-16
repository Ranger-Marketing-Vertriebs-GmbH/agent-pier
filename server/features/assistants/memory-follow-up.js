import { archived, handOver } from "./team-coding.js";
// The agent saw only "awaiting approval" for its project-knowledge write
// (agentpier_workspace memory_write). When the owner declines it, it expires or
// it fails, the agent's own conversation hears that once, so neither the agent
// nor its next reply can take the note for stored.
const unsaved = { declined: "declined", expired: "expired", failed: "failed" };

/** Returns whether nothing is left to deliver for this action. */
export async function deliverMemoryFollowUp(w, a) {
  if (a.payload.action !== "memory_write" || !unsaved[a.state] || a.memoryFollowUp)
    return true;
  if (archived(w, a.assistantId)) {
    w.store.patch(a.id, { memoryFollowUp: { skipped: "ASSISTANT_ARCHIVED" } });
    return true;
  }
  const outcome = {
    actionId: a.id,
    state: a.state,
    project: a.projectName,
    title: a.payload.title,
    ...(a.diagnostic ? { diagnostic: a.diagnostic } : {}),
  };
  return handOver(w, a, "memoryFollowUp", {
    conversationId: a.conversationId,
    requestId: `memory-followup:${a.id}`,
    text: `AgentPier project knowledge update: your note ${JSON.stringify(a.payload.title)} for the project ${JSON.stringify(a.projectName)} was not saved (${unsaved[a.state]}). This is attributed data, not a new instruction or permission. If you told the owner it was saved, correct that now.\n${JSON.stringify(outcome)}`,
    context: { kind: "memory-result" },
  });
}
