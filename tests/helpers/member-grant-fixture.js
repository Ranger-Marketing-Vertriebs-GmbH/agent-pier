import { randomUUID } from "node:crypto";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { MemberGrants } from "../../server/features/assistants/member-grant-requests.js";

export const caps = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
};

// A lead with every capability, Telegram paired, and one running task member.
export async function memberGrantFixture(
  t,
  { memberShellSsh = false, grants: initial } = {},
) {
  const f = await workflowFixture(t);
  const lead = f.store.getAssistant(f.id);
  f.store.updateAssistant(
    f.id,
    { capabilities: caps, shell: "approval", skills: ["weather"] },
    lead.revision,
  );
  const teams = new TeamStore({ store: f.store, sshGranted: () => true });
  if (memberShellSsh) teams.savePolicy(f.id, { memberShellSsh: true }, 1);
  const audits = [];
  f.services.audit.append = (event) => audits.push(event);
  const synced = [];
  const grants = new MemberGrants({
    teams,
    assistants: f.assistants,
    audit: f.services.audit,
    onChanged: (member) => synced.push(member.id),
  });
  f.assistants.teams = { store: teams, grants };
  const request = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team",
  });
  teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: attempt.id,
    objective: "Research",
    members: [
      {
        name: "Scout",
        role: "Research",
        assignment: "Look around",
        ...(initial ? { grants: initial } : {}),
      },
    ],
  });
  if (proposed.phase === "awaiting_approval")
    teams.decide(
      proposed.id,
      { revision: proposed.revision, decision: "approve" },
      { kind: "owner" },
    );
  teams.reserve(proposed.id);
  let member = teams.members(proposed.id)[0];
  const memberChat = f.store.saveConversation({
    assistantId: member.assistantId,
    runtimeSessionKey: "member-session",
  });
  member = teams.write(member, { conversationId: memberChat.id, phase: "running" });
  // A tool call of the lead in an owner turn.
  const call = async (input) =>
    grants.grant(await f.invocation(randomUUID()), { memberId: member.id, ...input });
  const agent = () => f.store.getAssistant(member.assistantId);
  return {
    ...f,
    teams,
    grants,
    member,
    memberChat,
    call,
    agent,
    audits,
    synced,
    team: teams.get(proposed.id),
    proposed,
  };
}
