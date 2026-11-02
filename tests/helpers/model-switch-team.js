import { chatFixture, holdBackgroundPasses } from "./user-chats.js";
import { fixtureModel } from "./user-agents.js";

// The owner's lead with its main chat, a permanent member done with its task and a
// temporary member at work; each member has its chat. The background passes stand
// still, so the stand-in team rows stay as written.
export async function switchTeam(t, { ownModel = false } = {}) {
  const { f, gateway } = await chatFixture(t);
  holdBackgroundPasses(f);
  const service = f.application.assistants;
  const lead = await (
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Lead", instructions: "", model: fixtureModel(f) },
    })
  ).json();
  const main = await (
    await f.request(`/api/assistants/${lead.id}/conversations`, { method: "POST" })
  ).json();
  const teams = service.teams.store;
  const request = service.ledger.accept(main.id, { clientRequestId: "team", text: "Go" });
  teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const attempt = service.ledger.recordAttempt(request.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: attempt.id,
    objective: "Research",
    members: [
      { name: "Scout", role: "Research", assignment: "Look around" },
      { name: "Keeper", role: "Notes", assignment: "Keep notes" },
    ],
  });
  if (proposed.phase === "awaiting_approval")
    teams.decide(
      proposed.id,
      { revision: proposed.revision, decision: "approve" },
      { kind: "owner" },
    );
  teams.reserve(proposed.id);
  service.ledger.transition(attempt.id, "completed");
  const chatOf = (m) =>
    service.store.saveConversation({
      assistantId: m.assistantId,
      runtimeSessionKey: `member-${m.name}`,
    });
  let [scout, keeper] = teams.members(proposed.id);
  scout = teams.write(scout, { conversationId: chatOf(scout).id, phase: "running" });
  keeper = teams.write(keeper, {
    conversationId: chatOf(keeper).id,
    lifetime: "permanent",
    phase: "completed",
  });
  service.store.db
    .prepare(
      "UPDATE assistants SET body=json_set(body,'$.lifetime','permanent') WHERE id=?",
    )
    .run(keeper.assistantId);
  if (ownModel) {
    const record = service.store.getAssistant(scout.assistantId);
    service.store.updateAssistant(
      scout.assistantId,
      { model: record.model },
      record.revision,
    );
  }
  return { f, gateway, service, lead, main, teams, scout, keeper };
}
