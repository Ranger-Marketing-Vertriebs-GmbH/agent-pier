import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { hostConnection, runtimeFor } from "./runtimes/runtime-for.js";
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
 * has exactly one unarchived main chat. `onCommit(next)` runs as soon as that
 * transaction commits; whatever fails after it (the note, the subscribe) is 503 unless
 * it carries a status. Callers hold admission.
 *
 * `options`: the note opening the fresh chat (`reason`, `details`; memory-notes.js),
 * whether the archived chat names it as its `successor` so late deliveries follow it
 * (chat-successor.js; a model switch does, Restart main chat does not) and whether the
 * fresh chat is `main`.
 */
export function freshMainChat(service, conversation, onCommit, options) {
  return swap(
    service,
    conversation,
    { ...(typeof conversation.userId === "string" && { userId: conversation.userId }) },
    onCommit,
    undefined,
    options,
  );
}

/**
 * The same swap for a permanent team member's chat (`member.conversationId`), the
 * one its lead's requests go to: the member row points at the fresh chat in the same
 * transaction. The member itself keeps running. Callers hold admission.
 */
export function freshMemberChat(service, member, onCommit, options) {
  const teams = service.teams.store;
  return swap(
    service,
    service.store.getConversation(member.conversationId),
    {},
    onCommit,
    (id) => teams.write(teams.member(member.id), { conversationId: id }),
    options,
  );
}

async function swap(
  service,
  conversation,
  owner,
  onCommit = () => {},
  linked = () => {},
  { reason = "main-restarted", details, successor = false, main = true } = {},
) {
  const assistant = service.store.getAssistant(conversation.assistantId);
  const id = randomUUID();
  // The session is created and later subscribed on the connection current now: once
  // the runtime replaced it, the subscribe rejects and the new connection hears nothing.
  const sessions = runtimeFor(assistant, service.runtime).sessions.on(
    hostConnection(service.runtime, assistant),
  );
  // A runtime that could not create the session is unavailable, not a bad request.
  const created = await sessions
    .create(
      {
        agentId: assistant.runtimeAgentId,
        label: `AgentPier ${assistant.id} main ${id}`,
      },
      service.sessionCreate,
    )
    .catch((error) => {
      throw unavailable(error, "session create");
    });
  if (!created?.key) throw assistantProblem("unavailable", 503);
  const { store } = service;
  store.db.exec("BEGIN IMMEDIATE");
  let next;
  try {
    store.updateConversation(conversation.id, {
      main: false,
      archivedAt: new Date().toISOString(),
      ...(successor && { successorId: id }),
    });
    next = store.saveConversation({
      id,
      assistantId: assistant.id,
      runtimeSessionKey: created.key,
      main,
      ...owner,
    });
    linked(id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  onCommit(next);
  try {
    service.feeds.end(conversation.id);
    // The note comes first: the swap has committed, whatever the subscribe does.
    service.memoryNotes.record({
      key: `${reason}:${id}`,
      conversationId: id,
      reason,
      ...(details !== undefined && { details }),
    });
    await sessions.subscribeMessages({ key: created.key });
  } catch (error) {
    throw unavailable(error, "finishing the swap");
  }
  return next;
}

// A failure without a status is unavailable, not a bad request; the original is
// logged and kept as the cause.
function unavailable(error, step) {
  if (error?.status) return error;
  console.error(`Main chat restart: ${step} failed:`, error?.message);
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
