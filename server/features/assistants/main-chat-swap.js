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
 * has exactly one unarchived main chat. Callers hold admission.
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
    throw error?.status ? error : assistantProblem("unavailable", 503);
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
  await client.call("sessions.messages.subscribe", { key: created.key });
  service.memoryNotes.record({
    key: `main-restarted:${id}`,
    conversationId: id,
    reason: "main-restarted",
  });
  return next;
}

/**
 * Points every Telegram channel of the agent whose chat was archived at its person's
 * main chat, then resyncs routines and check-ins, which bind the main chat's session.
 * Idempotent; runs outside admission (both resyncs take it).
 */
export async function repointDeliveries(service, assistantId) {
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
  await service.reminders?.routines?.resync(assistantId);
  await service.reminders?.heartbeats?.resync(assistantId);
}
