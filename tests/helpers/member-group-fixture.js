import { lead } from "./lead-request-service-fixture.js";

/**
 * A lead with three permanent members (`permanents`) and one temporary member, for
 * groups of permanent members (member-groups.js) and tasks to a whole group.
 */
export async function groupLead(t) {
  const f = await lead(t, { count: 4 });
  for (const m of [f.members[2], f.members[3]])
    await f.service.lifecycle("promote", m.id, f.service.store.member(m.id).revision);
  const permanents = [f.members[1], f.members[2], f.members[3]].map((m) =>
    f.service.store.member(m.id),
  );
  // The lead's tools: each call in a turn of its own, as the bridge would make it.
  const groups = async (input) => f.service.groups(f.turn(), input);
  const create = async (name) => (await groups({ action: "create", name })).groupId;
  const move = (memberId, groupId) => groups({ action: "move", memberId, groupId });
  const ungroup = (memberId) => groups({ action: "ungroup", memberId });
  const delegate = (groupId, inv = f.turn(), task = "Check the budget") =>
    f.service.group_delegate(inv, { groupId, task });
  // Every group record of the lead as stored, members as stored.
  const stored = () =>
    f.service.store
      .rows("member-group")
      .filter((g) => g.parentAssistantId === f.parent.id);
  const groupOf = (memberId) =>
    stored()
      .filter((g) => g.memberIds.includes(memberId))
      .map((g) => g.id);
  const parts = (groupTaskId) =>
    f.service.requests.store.list().filter((r) => r.groupTask?.id === groupTaskId);
  const followUps = () =>
    f.assistants.ledger
      .requests(f.chat.id)
      .filter((x) => x.clientRequestId.startsWith("lead-request-result:"));
  return {
    ...f,
    permanents,
    groups,
    create,
    move,
    ungroup,
    delegate,
    stored,
    groupOf,
    parts,
    followUps,
  };
}
