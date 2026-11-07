import { assistantProblem } from "./assistant-validation.js";
import { attachmentFile } from "./attachment-access.js";
import {
  openPinned,
  pinIdentity,
  pinType,
  sameIdentity,
  statIdentity,
} from "./agent-pinboard-files.js";

const inlineKinds = new Set(["image", "video", "audio"]);
const unchanged = (stored, now) =>
  !!stored &&
  stored.size === now.size &&
  stored.mtimeMs === now.mtimeMs &&
  stored.ino === now.ino;
const json = (value) => (value == null ? null : JSON.stringify(value));

/**
 * The owner's side of an agent's pinboard (agent-pinboard.js): the lists with each
 * entry's file as it is now, NEW marks, seen and the bytes. Every read opens the file
 * with the share rules again (openPinned, no scope: the agent's standing grants); an
 * entry whose file fails them reads "unavailable" and never throws. A file whose
 * size, modification time and inode still match the stored identity is trusted as
 * stored (nothing is hashed or sniffed); otherwise its identity is recomputed, and a
 * different content counts as a new version (store.setIdentity: once, also when two
 * views race).
 */
export class AgentPinboardView {
  constructor({ assistants, store, onChange = () => {} }) {
    Object.assign(this, { assistants, store, onChange });
    // What the view reads files with (a test counts the calls).
    this.files = { openPinned, pinIdentity, pinType };
  }

  // The chat by id, or null once it is deleted or never existed.
  conversation(id) {
    if (typeof id !== "string") return null;
    try {
      return this.assistants.store.getConversation(id);
    } catch {
      return null;
    }
  }

  /**
   * The chat history's cards (conversations.js): one message per list changed in a
   * turn (store.changesFor), carrying the list's current title, or the stored one with
   * `gone` once the list is deleted. `requestId` lets the owner-privacy window hide
   * it like a shared file.
   */
  notesFor(conversationId) {
    return this.store.changesFor(conversationId).map((change) => {
      const list = this.store.listOrNull(change.assistantId, change.listId);
      const { listId, requestId, added, updated, removed, names } = change;
      return {
        id: `pinboard:${listId}:${requestId}`,
        role: "assistant",
        text: "",
        timestamp: Date.parse(change.at),
        runId: null,
        requestId,
        pinboard: {
          listId,
          title: list ? list.title : change.title,
          added,
          updated,
          removed,
          names,
          gone: !list,
        },
      };
    });
  }

  // Opens the entry's file as the owner reads it: a workspace upload only while the
  // chat that admitted the pin still exists and may use it (AgentShares#admit).
  open(agent, entry) {
    const admit = (relative) => {
      const conversation = this.conversation(entry.admitConversationId);
      if (conversation)
        return this.assistants.shares.admit(agent, conversation, relative);
      if (attachmentFile(relative) !== null) throw assistantProblem("shareNotFound", 404);
    };
    return this.files.openPinned(
      this.assistants,
      agent,
      { root: entry.root, path: entry.path },
      { admit },
    );
  }

  // The identity of the opened file, stored when it moved; true when it was written.
  async current(entry, opened) {
    if (unchanged(entry.identity, statIdentity(opened.stat))) return false;
    const identity = {
      ...(await this.files.pinIdentity(opened.handle, opened.stat)),
      ...(await this.files.pinType(opened.handle, opened.size, opened.name)),
    };
    const bump = !sameIdentity(entry.identity, identity);
    this.store.setIdentity(entry.id, identity, { bump, expected: json(entry.identity) });
    return true;
  }

  // Opens and refreshes one entry; the open file, or null when it is unavailable.
  async check(agent, entry) {
    let opened;
    try {
      opened = await this.open(agent, entry);
    } catch {
      return { opened: null, written: false };
    }
    try {
      return { opened, written: await this.current(entry, opened) };
    } catch {
      await opened.handle.close();
      return { opened: null, written: false };
    }
  }

  async view(assistantId) {
    const agent = this.assistants.store.getAssistant(assistantId);
    const states = new Map();
    let written = false;
    let lists = this.store.lists(assistantId);
    for (const list of lists) {
      if (list.archivedAt) continue;
      for (const entry of list.entries) {
        const checked = await this.check(agent, entry);
        await checked.opened?.handle.close();
        states.set(entry.id, checked.opened ? "ok" : "unavailable");
        written ||= checked.written;
      }
    }
    // What a refresh (or a view racing this one) stored, versions and order included.
    if (written) lists = this.store.lists(assistantId);
    let fresh = 0;
    const shown = lists.map((list) => {
      const entries = list.entries.map((entry) => {
        const state = list.archivedAt ? "ok" : states.get(entry.id) || "ok";
        const isFresh =
          !list.archivedAt &&
          state === "ok" &&
          !sameIdentity(entry.identity, entry.seenIdentity);
        if (isFresh) fresh++;
        return viewEntry(entry, state, isFresh);
      });
      const origin = this.conversation(list.originConversationId);
      return {
        id: list.id,
        title: list.title,
        description: list.description,
        origin: origin
          ? { conversationId: origin.id, title: origin.title ?? null }
          : null,
        archived: !!list.archivedAt,
        updatedAt: list.updatedAt,
        entries,
      };
    });
    return { lists: shown, fresh };
  }

  // The entry's file, open and current, or pinboardUnavailable.
  async opened(assistantId, entryId) {
    const agent = this.assistants.store.getAssistant(assistantId);
    const entry = this.store.entry(assistantId, entryId);
    const { opened } = await this.check(agent, entry);
    if (!opened) throw assistantProblem("pinboardUnavailable", 404);
    return { opened, entry: this.store.entry(assistantId, entryId) };
  }

  async seen(assistantId, entryId) {
    const { opened, entry } = await this.opened(assistantId, entryId);
    await opened.handle.close();
    this.store.markSeen(assistantId, entryId, entry.identity);
    this.onChange(assistantId);
  }

  /** The file for the byte route; the caller closes `handle`. */
  async file(assistantId, entryId) {
    const { opened, entry } = await this.opened(assistantId, entryId);
    const kind = entry.identity?.kind || "file";
    return {
      name: opened.name,
      type: entry.identity?.type || "application/octet-stream",
      kind,
      inline: inlineKinds.has(kind),
      handle: opened.handle,
      size: opened.size,
    };
  }
}

function viewEntry(entry, state, fresh) {
  const identity = entry.identity || {};
  return {
    id: entry.id,
    name: entry.name,
    note: entry.note,
    version: entry.version,
    kind: identity.kind || "file",
    type: identity.type || "application/octet-stream",
    size: identity.size ?? 0,
    ...(Number.isFinite(identity.duration) ? { duration: identity.duration } : {}),
    state,
    fresh,
    updatedAt: entry.updatedAt,
  };
}
