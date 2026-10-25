import { audienceOf } from "../assistants/reminder-audience.js";
import { memberLevel } from "./user-access.js";
import {
  deleteNativeSession,
  forgetChat,
  markArchivePurges,
} from "../assistants/chat-removal.js";

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
    // Marked first: a Gateway that is away deletes the native session at its next start.
    // userReleased keeps reconciliation from reading her native session back.
    store.forgetConversation(conversation.id, {
      archivedAt: new Date().toISOString(),
      nativeDeletePending: true,
      userReleased: true,
    });
    await forgetChat(assistants, conversation);
    await deleteNativeSession(assistants, conversation);
  }
  assistants.changed();
}

/**
 * A deleted user's reminders, routines and check-ins without her opt-in, once ended
 * (endUserBindings): what she wrote into them goes. The ended binding keeps only what
 * finds and removes its native job.
 */
export function forgetUserBindings(services, userId) {
  const reminders = services.assistants?.reminders;
  if (!reminders) return;
  for (const agent of services.assistants.store.listAssistants())
    for (const binding of reminders.bindings.list(agent.id))
      if (audienceOf(binding) === userId && revoked(binding))
        reminders.bindings.patch(binding.id, { definition: null, fingerprint: null });
}

/**
 * The native sessions of deleted users' chats, and of deleted chats, that a Gateway
 * away at the deletion kept (releaseUserData, chat-removal.js): deleted at the next
 * Gateway start, after markArchivePurges has marked those deleted before AgentPier
 * purged OpenClaw's transcript archives. Never throws.
 */
export async function deleteReleasedSessions({ assistants }) {
  try {
    markArchivePurges(assistants.store);
    for (const conversation of assistants.store.listConversations({ deleted: true }))
      if (conversation.nativeDeletePending)
        await deleteNativeSession(assistants, conversation);
  } catch {
    /* Retried at the next Gateway start. */
  }
}

/**
 * Her reminders, routines and check-ins on her agents, before releaseUserData: revoked
 * at once and removed with their native jobs where the Gateway answers, otherwise at
 * its next start. The removal takes the agents' admission itself, so this runs outside
 * it; inside, it would wait on its own lock forever.
 */
export async function endUserBindings(services, userId, released = false) {
  const store = services.assistants.store;
  // After her release she belongs to no agent: any agent may still hold a binding.
  if (released) return endBindings(services, store.listAssistants(), userId, false);
  const agents = store.listAssistants().filter((a) => memberLevel(a, userId));
  await endBindings(services, agents, userId);
  await forgetChannels(services, userId);
}

/**
 * After the owner removed users from an agent (UserAgents.assign): their reminders,
 * routines and Telegram bot on it end, so nothing of theirs keeps using the agent.
 * Runs outside the admission, like endUserBindings.
 */
export async function releaseMembers(services, agentId, userIds) {
  const agent = services.assistants.store.getAssistant(agentId);
  for (const userId of userIds) {
    await endBindings(services, [agent], userId, false);
    await forgetChannels(services, userId, agentId);
  }
}

/** After users fell below Extended on an agent: their bots on it end with the level. */
export async function releaseBots(services, agentId, userIds) {
  for (const userId of userIds) await forgetChannels(services, userId, agentId);
}

/**
 * After a shared agent became a user's own (UserAgents.assign): the owner's
 * reminders, routines and Telegram bot on it end like a removed member's. Her turns
 * may now use every file of its attachments folder and watch its browser at any
 * time, so the uploads of everyone else's chats go and the browser closes the tabs
 * their turns left open.
 */
export async function releaseOwner(services, agentId) {
  const { assistants } = services;
  const agent = assistants.store.getAssistant(agentId);
  await endBindings(services, [agent], null, false);
  await forgetChannels(services, null, agentId);
  const userId = agent.userAccess?.members[0]?.userId;
  await assistants.attachments?.storage
    .removeChats(
      agentId,
      (conversationId) => chatUser(assistants, conversationId) === userId,
    )
    .catch(() => {});
  await assistants.browsers?.stopAgent(agentId).catch(() => {});
}

function chatUser(assistants, conversationId) {
  try {
    const { userId } = assistants.store.storedConversation(conversationId);
    return typeof userId === "string" ? userId : null;
  } catch {
    return undefined;
  }
}

// Her own bots deliver into her chats: they go with her, token, texts and all.
async function forgetChannels({ assistants, assistantChannels }, userId, agentId) {
  if (!assistantChannels) return;
  const store = assistants.store;
  for (const channel of assistantChannels.store.list()) {
    if (agentId && channel.assistantId !== agentId) continue;
    let conversation = null;
    try {
      conversation = store.getConversation(channel.conversationId);
    } catch {
      continue;
    }
    if ((typeof conversation.userId === "string" ? conversation.userId : null) === userId)
      await assistantChannels.forget(channel.id).catch(() => {});
  }
}

async function endBindings(services, agents, userId, everything = true) {
  const reminders = services.assistants.reminders;
  if (!reminders) return;
  for (const agent of agents)
    for (const binding of reminders.bindings.list(agent.id)) {
      const own = everything && agent.userAccess?.mode === "own";
      if (revoked(binding) || (audienceOf(binding) !== userId && !own)) continue;
      // Revoked at once, so a late run delivers nothing; its native job goes below.
      reminders.bindings.patch(binding.id, { state: "revoked", userReleased: true });
    }
  await retireReleased(services, agents);
}

const revoked = (binding) => ["revoked", "removed"].includes(binding.state);

/**
 * Removes the native jobs of reminders, routines and check-ins a user took with her
 * (endBindings): each would keep running turns in her old chat. Where the Gateway does
 * not answer, the binding stays revoked and the next Gateway start retries it
 * (assistant-graph.js). Takes the agents' admission; never throws.
 */
export async function retireReleased(services, agents) {
  const assistants = services.assistants;
  const reminders = assistants?.reminders;
  if (!reminders) return;
  await assistants
    .admit(async () => {
      if (!assistants.runtime.client?.ready) return;
      for (const agent of agents || assistants.store.listAssistants()) {
        const released = reminders.bindings
          .list(agent.id)
          .filter((b) => b.userReleased && b.state === "revoked");
        if (!released.length) continue;
        try {
          const jobs = await reminders.jobs(assistants.store.getAssistant(agent.id));
          for (const binding of released) {
            const job = reminders.find(binding, jobs);
            if (job) await assistants.runtime.client.call("cron.remove", { id: job.id });
            reminders.bindings.patch(binding.id, { state: "removed" });
          }
        } catch {
          /* Retried at the next Gateway start. */
        }
      }
      assistants.changed();
    })
    .catch(() => {});
}
