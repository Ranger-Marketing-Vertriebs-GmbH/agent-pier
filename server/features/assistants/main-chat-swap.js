import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { createGatewaySession } from "./session-create.js";
import { channelPerson, mainConversation } from "./routine-targets.js";

/**
 * The swap behind Restart main chat (main-chat-restart.js): a person's main chat is
 * archived and a fresh one with its own native session takes its place. The old
 * native session is never deleted, and nothing is saved from it first; the archived
 * chat stays readable. Deliveries then follow the new main chat.
 */

/**
 * Replaces `conversation`, a person's main chat, with a fresh one and returns it. The
 * Gateway session comes first: a failing create leaves both chats as they were. The
 * old chat is archived and the new one saved in one transaction, so the person always
 * has exactly one unarchived main chat. A subscribe that fails after that throws with
 * the new chat as `committed`. Callers hold admission.
 */
export function freshMainChat(service, conversation) {
  return swap(service, conversation, {
    ...(typeof conversation.userId === "string" && { userId: conversation.userId }),
  });
}

/**
 * The same swap for a permanent team member's chat (`member.conversationId`), the
 * one its lead's requests go to: the member row points at the fresh chat in the same
 * transaction. The member itself keeps running. Callers hold admission.
 */
export function freshMemberChat(service, member) {
  const teams = service.teams.store;
  return swap(service, service.store.getConversation(member.conversationId), {}, (id) =>
    teams.write(teams.member(member.id), { conversationId: id }),
  );
}

async function swap(service, conversation, owner, linked = () => {}) {
  const assistant = service.store.getAssistant(conversation.assistantId);
  const id = randomUUID();
  const client = service.runtime.client;
  // A Gateway that could not create the session is unavailable, not a bad request.
  const created = await createGatewaySession(
    client,
    { agentId: assistant.runtimeAgentId, label: `AgentPier ${assistant.id} main ${id}` },
    service.sessionCreate,
  ).catch((error) => {
    throw unavailable(error, "create");
  });
  if (!created?.key) throw assistantProblem("unavailable", 503);
  const { store } = service;
  store.db.exec("BEGIN IMMEDIATE");
  let next;
  try {
    store.updateConversation(conversation.id, {
      main: false,
      archivedAt: new Date().toISOString(),
    });
    next = store.saveConversation({
      id,
      assistantId: assistant.id,
      runtimeSessionKey: created.key,
      main: true,
      ...owner,
    });
    linked(id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  service.feeds.end(conversation.id);
  // The note comes first: the swap has committed, whatever the subscribe does.
  service.memoryNotes.record({
    key: `main-restarted:${id}`,
    conversationId: id,
    reason: "main-restarted",
  });
  try {
    await client.call("sessions.messages.subscribe", { key: created.key });
  } catch (error) {
    throw Object.assign(unavailable(error, "subscribe"), { committed: next });
  }
  return next;
}

// A Gateway failure without a status is unavailable, not a bad request; the
// original is logged and kept as the cause.
function unavailable(error, step) {
  if (error?.status) return error;
  console.error(`Main chat restart: session ${step} failed:`, error?.message);
  return Object.assign(assistantProblem("unavailable", 503), { cause: error });
}

/**
 * Points every Telegram channel of the agent whose chat was archived at its person's
 * main chat. Idempotent; callers hold admission, right after the swap.
 */
export function moveChannels(service, assistantId) {
  const channels = service.channels;
  for (const channel of channels?.store.list() || []) {
    if (channel.assistantId !== assistantId) continue;
    let current;
    try {
      current = service.store.getConversation(channel.conversationId);
    } catch {
      continue;
    }
    if (!current.archivedAt) continue;
    const person = channelPerson(channels, channel);
    if (person === undefined) continue;
    const main = mainConversation(service.store, assistantId, person);
    if (main) channels.store.moveConversation(channel.id, main.id);
  }
}

/**
 * Resyncs the agent's routines and check-ins, which bind the main chat's session.
 * Runs outside admission: both resyncs take it.
 */
export async function resyncDeliveries(service, assistantId) {
  await service.reminders?.routines?.resync(assistantId);
  await service.reminders?.heartbeats?.resync(assistantId);
}
