import { EventEmitter } from "node:events";
import { isUserAgent } from "./user-access.js";

const time = (value) =>
  typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
// An entry the owner may see: one at or after `since`; undated ones are left out.
const after = (sinceMs) => (value) => {
  const at = time(value);
  return Number.isFinite(at) && at >= sinceMs;
};

/**
 * A history window or feed snapshot as the owner sees a user's chat under her opt-in:
 * only what happened from `since` on, never earlier messages, turns or files.
 */
export function fromSince(history, since) {
  if (!since || !history) return history;
  const keep = after(Date.parse(since));
  return {
    ...history,
    messages: (history.messages || []).filter((m) => keep(m.timestamp)),
    requests: (history.requests || []).filter((r) => keep(r.createdAt)),
    ...(Array.isArray(history.actions) && {
      actions: history.actions.filter((a) => keep(a.createdAt)),
    }),
    // Older pages hold only what came before the opt-in.
    nextBefore: null,
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
  /** Whether the conversation shows in the owner's list at all. */
  visible(conversation) {
    return this.conversation(conversation).readable;
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
      conversations: (list.conversations || []).filter((c) => this.visible(c)),
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
