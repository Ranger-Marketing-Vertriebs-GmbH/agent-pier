import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { LeadRequestStore } from "../../server/features/assistants/lead-request-store.js";

/** Leads with finished teams whose members can be asked, on a real team store. */
export function leadStoreFixture(t, { store: given } = {}) {
  const dataDir = given ? null : fs.mkdtempSync(path.join(os.tmpdir(), "lead-requests-"));
  const store = given || new AssistantStore({ dataDir });
  const teams = new TeamStore({ store }),
    ledger = new RequestLedger(store.db),
    requests = new LeadRequestStore(teams);
  if (!given)
    t.after(() => {
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
  let sessions = 0;
  function lead(name = "Lead") {
    const assistant = store.createAssistant({
      name,
      instructions: "Lead the team",
      model: { connectionId: "c", modelId: "m" },
    });
    const chat = store.saveConversation({
      assistantId: assistant.id,
      runtimeSessionKey: `lead-${sessions++}`,
    });
    return { assistant, chat };
  }
  /** One turn of the lead's chat with the trusted context AgentPier recorded. */
  function turn(chat, text, context = { kind: "owner" }) {
    const request = ledger.accept(chat.id, {
      clientRequestId: crypto.randomUUID(),
      text,
    });
    teams.recordContext(request.id, context);
    return ledger.recordAttempt(request.id);
  }
  /** A started team of `count` members, each with a chat and in `phase`. */
  function team(owner, { count = 2, phase = "completed" } = {}) {
    const attempt = turn(owner.chat, "Build a team", {
      kind: "owner",
      teamAllowed: true,
    });
    const proposal = teams.propose({
      operationId: crypto.randomUUID(),
      parentAttemptId: attempt.id,
      objective: "Research",
      members: Array.from({ length: count }, (_, n) => ({
        name: `Member ${n}`,
        role: "Research",
        assignment: `Research part ${n}`,
      })),
    });
    ledger.transition(attempt.id, "completed");
    const reserved = teams.reserve(proposal.id);
    // Ended, so the lead may start another team.
    teams.write(reserved, { phase: phase === "completed" ? "completed" : "running" });
    return reserved.memberIds.map((id) => {
      const member = teams.member(id);
      const chat = store.saveConversation({
        assistantId: member.assistantId,
        runtimeSessionKey: `member-${sessions++}`,
      });
      return teams.write(member, { conversationId: chat.id, phase });
    });
  }
  const promote = (member) => teams.promote(member.id, teams.member(member.id).revision);
  const archive = (member) => teams.archive(member.id, teams.member(member.id).revision);
  return {
    store,
    teams,
    ledger,
    requests,
    lead,
    turn,
    team,
    promote,
    archive,
    dataDir,
  };
}
