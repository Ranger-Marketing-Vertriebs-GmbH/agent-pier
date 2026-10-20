import { EventEmitter } from "node:events";
import { isUserAgent } from "./user-access.js";

const time = (value) =>
  typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
// An entry the owner may see: one at or after `since`; undated ones are left out.
const after = (sinceMs) => (value) => {
  const at = time(value);
  return Number.isFinite(at) && at >= sinceMs;
};

/** The time a request counts from: when she wrote it, not when it went out. */
export const requestWritten = (request) => request.writtenAt ?? request.createdAt;

/** Whether a request lies before `since`: then its turn and reply stay hers. */
export const beforeSince = (request, since) =>
  !after(Date.parse(since))(requestWritten(request));

/**
 * A history window or feed snapshot as the owner sees a user's chat under her opt-in:
 * only what happened from `since` on, never earlier messages, turns or files.
 */
export function fromSince(history, since) {
  if (!since || !history) return history;
  const sinceMs = Date.parse(since);
  const keep = after(sinceMs);
  // A message she queued before the opt-in counts from when she wrote it, not from
  // when it went out; its transcript entry and the reply its run wrote are hers too.
  const requests = history.requests || [];
  const earlier = requests.filter((r) => beforeSince(r, since));
  const hidden = new Set(earlier.map((r) => r.id));
  const runs = new Set(
    earlier.flatMap((r) => [r.attempt?.id, r.attempt?.runtimeRunId]).filter(Boolean),
  );
  const messages = history.messages || [];
  // An older page holds what the owner may read until it reaches back past `since`.
  const dated = messages.map((m) => time(m.timestamp)).filter((at) => at > 0);
  const reachesSince = !dated.length || Math.min(...dated) < sinceMs;
  return {
    ...history,
    messages: messages.filter(
      (m) => keep(m.timestamp) && !hidden.has(m.requestId) && !runs.has(m.runId),
    ),
    requests: requests.filter((r) => !hidden.has(r.id)),
    ...(Array.isArray(history.actions) && {
      actions: history.actions.filter((a) => keep(a.createdAt)),
    }),
    // A message queued before the opt-in stays hers, with its files.
    ...(history.queued && {
      queued: keep(history.queued.createdAt) ? history.queued : null,
    }),
    nextBefore: reachesSince ? null : (history.nextBefore ?? null),
  };
}

/**
 * What the owner may read of his users' agents. A user's chats, and the memory,
 * files, attachments and browser of her own agent, are private unless she let the
 * owner read them (`ownerMayRead`), and then only from `since`. Shared agents keep
 * their shared memory and settings readable; their chats stay each user's own.
 * Emits `revoked` (userId) when a user's opt-in ends, so open views close.
 */
export class OwnerPrivacy extends EventEmitter {
  constructor({ users, assistants = () => null }) {
    super();
    this.users = users;
    this.assistants = assistants;
  }
  // The user's opt-in, or a closed one when she is gone.
  optIn(userId) {
    try {
      const { ownerMayRead } = this.users.get(userId);
      return ownerMayRead?.enabled ? ownerMayRead : { enabled: false, since: null };
    } catch {
      return { enabled: false, since: null };
    }
  }
  /** Whether the owner may read a conversation, and from when. */
  conversation(conversation) {
    if (typeof conversation?.userId !== "string") return { readable: true, since: null };
    // A deleted user's chat kept under her opt-in stays readable from its since.
    if (conversation.deletedUser && conversation.ownerMayReadSince)
      return { readable: true, since: conversation.ownerMayReadSince };
    const { enabled, since } = this.optIn(conversation.userId);
    return { readable: enabled, since: enabled ? since : null };
  }
  /** Whether a chat file created at `createdAt` lies within the owner's window. */
  fileVisible(createdAt, since) {
    return !since || after(Date.parse(since))(createdAt);
  }
  /** Whether the conversation shows in the owner's list at all. */
  visible(conversation) {
    return this.conversation(conversation).readable;
  }
  /**
   * How the owner's lists show a conversation, or null: his own chats whole, a
   * user's only under her opt-in and only once it was active from its `since` on. A
   * chat she started before that keeps its title to herself: the title comes from
   * her first message.
   */
  view(conversation) {
    if (typeof conversation?.userId !== "string") return conversation;
    const { readable, since } = this.conversation(conversation);
    if (!readable) return null;
    if (!since) return conversation;
    const keep = after(Date.parse(since));
    if (!keep(conversation.lastActivityAt || conversation.createdAt)) return null;
    return keep(conversation.createdAt) ? conversation : { ...conversation, title: null };
  }
  /**
   * Whether the owner may read an agent's content (memory, files, attachments,
   * browser): his own agents and shared agents yes, a user's own agent only under her
   * opt-in.
   */
  agentContent(agent) {
    if (!isUserAgent(agent) || agent.userAccess.mode !== "own") return true;
    return this.optIn(agent.userAccess.members[0]?.userId).enabled;
  }
  /** The owner's agent list without the chats he may not read. */
  filterList(list) {
    return {
      ...list,
      conversations: (list.conversations || []).map((c) => this.view(c)).filter(Boolean),
    };
  }
  /**
   * The owner's channel list: a channel delivering into a user's chat shows her
   * Telegram identity and texts only under her opt-in, and only from its `since`.
   */
  filterChannels(list, conversationOf) {
    return {
      ...list,
      channels: (list.channels || []).map((channel) => {
        let conversation = null;
        try {
          conversation = conversationOf(channel.conversationId);
        } catch {
          // A channel without its chat shows no texts of anyone.
        }
        if (conversation && typeof conversation.userId !== "string") return channel;
        const { readable, since } = this.conversation(conversation || { userId: "" });
        const keep = !readable
          ? () => false
          : since
            ? (entry) => after(Date.parse(since))(entry.createdAt)
            : () => true;
        return {
          ...channel,
          ...(!readable && { chatId: null, userId: null }),
          inputs: (channel.inputs || []).filter(keep),
          notifications: (channel.notifications || []).filter(keep),
        };
      }),
    };
  }
  /** Sets a user's opt-in; ending it closes every view the owner has open of hers. */
  set(userId, enabled) {
    const user = this.users.setOwnerMayRead(userId, enabled);
    if (!enabled) this.emit("revoked", userId);
    this.emit("changed", userId);
    return user;
  }
}
