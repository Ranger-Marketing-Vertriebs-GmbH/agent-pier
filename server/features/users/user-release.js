import { audienceOf } from "../assistants/reminder-audience.js";
import { memberLevel } from "./user-access.js";

/**
 * Everything of a deleted user's on the agents (UserAgents.releaseUser): her own
 * agents are archived or kept as the owner's, shared agents lose her as a member,
 * her reminders and routines end, and her chats go with her: archived, their native
 * sessions, cached messages and files deleted. Under her opt-in the owner keeps them,
 * readable from its `since` and marked as a deleted user's.
 */
export async function releaseUserData(services, userId, mode, optIn) {
  const assistants = services.assistants;
  const store = assistants.store;
  const agents = store.listAssistants().filter((a) => memberLevel(a, userId));
  await endBindings(services, agents, userId);
  for (const agent of agents) {
    if (agent.userAccess.mode === "own") {
      if (mode === "archive") {
        await assistants.reminders?.disable(agent.id).catch(() => {});
        store.changeUserAgent(agent.id, { archivedAt: new Date().toISOString() });
      } else store.changeUserAgent(agent.id, { userAccess: null });
    } else {
      // A shared agent without users stays a user agent under the hard lock.
      const members = agent.userAccess.members.filter((m) => m.userId !== userId);
      store.changeUserAgent(agent.id, { userAccess: { ...agent.userAccess, members } });
    }
  }
  for (const conversation of store.listConversations()) {
    if (conversation.userId !== userId) continue;
    if (optIn?.enabled) {
      store.updateConversation(conversation.id, {
        deletedUser: true,
        ownerMayReadSince: optIn.since,
      });
      continue;
    }
    store.updateConversation(conversation.id, { archivedAt: new Date().toISOString() });
    try {
      assistants.queued?.take(conversation.id);
    } catch {
      /* Nothing queued. */
    }
    await removeFiles(assistants, conversation).catch(() => {});
    store.forgetMessages(conversation.id);
    await assistants.runtime.client
      ?.call("sessions.delete", { key: conversation.runtimeSessionKey })
      .catch(() => {});
  }
  services.notifications?.forgetUser(userId);
  assistants.changed();
}

// Her reminders, routines and check-ins: removed with their native jobs where the
// Gateway answers, otherwise revoked, so a late run delivers nothing.
async function endBindings({ assistants }, agents, userId) {
  const reminders = assistants.reminders;
  if (!reminders) return;
  const routines = reminders.routines;
  for (const agent of agents)
    for (const binding of reminders.bindings.list(agent.id)) {
      const own = agent.userAccess.mode === "own";
      if (binding.state === "removed" || (audienceOf(binding) !== userId && !own))
        continue;
      const service = binding.kind === "routine" ? routines : reminders;
      try {
        if (binding.kind === "heartbeat") throw Error("retired below");
        await service.remove(agent.id, binding.id);
      } catch {
        reminders.bindings.patch(binding.id, { state: "removed" });
      }
    }
}

// The files of her chat: her uploads and what her agent shared with her.
async function removeFiles(assistants, conversation) {
  const attachments = assistants.attachments;
  const files = attachments.rows(
    "SELECT * FROM agent_attachments WHERE conversation_id=?",
    conversation.id,
  );
  const folder = await attachments.folder(conversation.assistantId, false);
  for (const file of files) {
    if (file.shared)
      await attachments.shared.remove(conversation.id, file.id).catch(() => {});
    if (folder && !file.shared) await attachments.remove(file, folder.path);
    else attachments.db.prepare("DELETE FROM agent_attachments WHERE id=?").run(file.id);
  }
}
