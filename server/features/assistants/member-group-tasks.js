import { createHash } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { callerOf, exact } from "./lead-request-store.js";
import { groupFollowUp } from "./lead-request-text.js";
import { recordedTurn } from "./goal-turns.js";
import { loopGuard } from "./agent-loop-guard.js";

// A lead's groups of permanent members (member-groups.js) through its team tools, and
// tasks to a whole group (AGENTPIER-283). A group task fans out in parallel: every
// member of the group gets an ordinary lead task (lead-request-store.js) with the
// same text, its own write rules and limits (one open task per member, the open-
// request cap and the agent loop guard), and runs and ends on its own. The lead
// gets no follow-up per member: once every part ended (completed, failed, cancelled
// or stopped at its time limit) one follow-up with all results reaches it on the
// first part's delivery (its "anchor"), and the lead writes the owner one summary.
// A moved, removed or archived member keeps its part: the parts were fixed when the
// task was given.
const ended = new Set(["completed", "failed", "cancelled"]);

/** The parts of the group task `r` belongs to, in the order they were given. */
export const groupParts = (requests, r) =>
  requests.store
    .list(r.parentAssistantId)
    .filter((x) => x.groupTask?.id === r.groupTask.id);

/** The lead's groups with their members' names, as the groups tool returns them. */
export function groupsView(service, leadId) {
  const name = (memberId) => {
    const m = service.store.find(memberId);
    return service.assistants.store.getAssistant(m.assistantId).name;
  };
  const groups = service.memberGroups.list(leadId);
  const grouped = new Set(groups.flatMap((g) => g.memberIds));
  const permanent = service.requests
    .reachable(leadId)
    .filter(({ m }) => m.lifetime === "permanent");
  return {
    groups: groups.map((g) => ({
      groupId: g.id,
      name: g.name,
      members: g.memberIds.map((memberId) => ({ memberId, name: name(memberId) })),
    })),
    ungrouped: permanent
      .filter(({ m }) => !grouped.has(m.id))
      .map(({ m, a }) => ({ memberId: m.id, name: a.name })),
  };
}

const groupActions = {
  list: { keys: [], required: [] },
  create: { keys: ["name"], required: ["name"] },
  rename: { keys: ["groupId", "name"], required: ["groupId", "name"] },
  delete: { keys: ["groupId"], required: ["groupId"] },
  move: { keys: ["memberId", "groupId"], required: ["memberId", "groupId"] },
  ungroup: { keys: ["memberId"], required: ["memberId"] },
};

/** agentpier_team_groups: list, create, rename, delete, move and ungroup. */
export function groupTool(service, inv, input) {
  const spec = groupActions[input?.action];
  if (!spec) throw assistantProblem("invalid");
  exact(input, ["action", ...spec.keys], ["action", ...spec.required]);
  inv.assertCurrent();
  const { lead } = service.requests.store.caller(callerOf(inv));
  const groups = service.memberGroups;
  let result = {};
  if (input.action !== "list") {
    groups.assertLead(lead.id);
    loopGuard(service.store.store).take(lead.id);
  }
  if (input.action === "create")
    result = {
      groupId: groups.create(lead.id, input.name, `${inv.attemptId}:${inv.toolCallId}`)
        .id,
    };
  else if (input.action === "rename")
    result = { groupId: groups.rename(lead.id, input.groupId, input.name).id };
  else if (input.action === "delete")
    result = { deleted: groups.remove(lead.id, input.groupId).id };
  else if (input.action === "move" || input.action === "ungroup")
    result = {
      moved: groups.move(
        lead.id,
        input.memberId,
        input.action === "move" ? input.groupId : null,
      ),
    };
  if (input.action !== "list") service.assistants.changed();
  return { ...result, ...groupsView(service, lead.id) };
}

/**
 * agentpier_team_group_delegate: the same task for every member of a group, all or
 * none. An empty group, or one whose member already has an open task, is refused.
 */
export async function groupDelegate(service, inv, input) {
  exact(
    input,
    ["groupId", "task", "ownerRequested", "ownerRequestQuote"],
    ["groupId", "task"],
  );
  inv.assertCurrent();
  const requests = service.requests;
  const { lead } = requests.store.caller(callerOf(inv));
  const group = service.memberGroups.get(lead.id, input.groupId);
  const memberIds = service.memberGroups
    .list(lead.id)
    .find((g) => g.id === group.id).memberIds;
  if (!memberIds.length) throw assistantProblem("memberGroupEmpty", 409);
  const offer = await requests.lastReply(inv, input);
  inv.assertCurrent();
  const call = `${inv.attemptId ?? inv.sessionKey}:${inv.toolCallId}`;
  const id = `group-task:${createHash("sha256").update(call).digest("hex").slice(0, 32)}`;
  const { groupId: _groupId, ...task } = input;
  let parts;
  try {
    parts = service.store.transaction(() =>
      memberIds.map((memberId, n) =>
        requests.store.create({
          type: "task",
          ...callerOf(inv),
          operationId: `${inv.toolCallId}:${memberId}`,
          input: { ...task, memberId },
          offer,
          groupTask: {
            id,
            groupId: group.id,
            name: group.name,
            size: memberIds.length,
            ...(n === 0 ? { anchor: true } : {}),
          },
        }),
      ),
    );
  } catch (error) {
    if (error?.key === "memberRequestOpenTask")
      throw assistantProblem("memberGroupOpenTask", 409);
    throw error;
  }
  // All parts start at once; each waits for its member like a single task.
  const started = await Promise.all(parts.map((r) => requests.started(r)));
  return {
    groupTaskId: id,
    group: group.name,
    status: "delegated",
    note: "Every member works on the task in its own chat. One follow-up with all results reaches you once every part ended, also when some fail or run out of time; then write the owner one summary.",
    tasks: started.map((r) => requests.toolResult(r)),
  };
}

/**
 * deliverRequest for a part of a group task: true when this part delivers nothing
 * now. A part other than the anchor never has its own follow-up and is settled once
 * the anchor's is. The anchor waits until every part ended; its follow-up is skipped
 * only when the lead itself cancelled every part.
 */
export function holdForGroup(requests, r) {
  const parts = groupParts(requests, r);
  const anchor = parts.find((x) => x.groupTask.anchor);
  if (!r.groupTask.anchor) {
    const done = !anchor || anchor.settled;
    if (r.delivery !== "group" || done)
      requests.teams.write(r, { delivery: "group", ...(done ? { settled: true } : {}) });
    return true;
  }
  if (parts.some((x) => !ended.has(x.phase))) return true;
  if (parts.every((x) => x.phase === "cancelled" && x.cancelledBy === "lead")) {
    requests.teams.write(r, { delivery: "skipped", settled: true });
    return true;
  }
  return false;
}

/**
 * The anchor's follow-up: its own target (chat, delivery key, goal turn), with the
 * text of every part and the group named in the context instead of one outcome.
 */
export function groupTarget(requests, r) {
  const base = requests.deliveryTarget(r);
  const lost =
    base.conversationId &&
    recordedTurn(requests.teams, base.conversationId, base.clientRequestId);
  if (lost) return base;
  const parts = groupParts(requests, r).map((x) => ({
    ...x,
    answer: requests.store.answer(x),
  }));
  const tag = ({ outcome: _outcome, ...result }) => ({
    ...result,
    groupTaskId: r.groupTask.id,
    group: r.groupTask.name,
  });
  return {
    ...base,
    text: groupFollowUp(r.groupTask.name, parts),
    context:
      base.context.kind === "member-result"
        ? tag(base.context)
        : { ...base.context, result: tag(base.context.result) },
  };
}
