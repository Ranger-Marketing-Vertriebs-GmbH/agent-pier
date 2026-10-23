// The unsent text of each agent chat, and its picked files (`attachments`). Both live
// as long as the page, not the composer: a reload starts every chat empty.
export class AssistantDrafts {
  constructor(attachments = new AttachmentDrafts()) {
    this.values = new Map();
    this.attachments = attachments;
  }
  get(id) {
    return this.values.get(id)?.text || "";
  }
  set(id, text) {
    if (this.get(id) !== text)
      this.values.set(id, { ...this.values.get(id), text, clientRequestId: null });
  }
  teamAllowed(id) {
    return this.values.get(id)?.teamAllowed === true;
  }
  allowTeam(id, allowed) {
    const value = { ...this.values.get(id), text: this.get(id), clientRequestId: null };
    if (allowed) value.teamAllowed = true;
    else delete value.teamAllowed;
    this.values.set(id, value);
  }
  // Other files make another message: the next delivery gets a new key.
  attach(id) {
    const value = this.values.get(id);
    if (value?.clientRequestId) this.values.set(id, { ...value, clientRequestId: null });
  }
  delivery(id) {
    const value = this.values.get(id) || { text: "" };
    value.clientRequestId ||= crypto.randomUUID();
    this.values.set(id, value);
    return { ...value };
  }
  acknowledge(id, clientRequestId) {
    if (this.values.get(id)?.clientRequestId !== clientRequestId) return false;
    this.clear(id);
    return true;
  }
  clear(id) {
    this.values.delete(id);
  }
  // A logout or another user: no chat keeps the previous text or files.
  clearAll() {
    this.values.clear();
    this.attachments.clearAll();
  }
}

/**
 * Every agent chat's attachment draft of this page, by the chat's route. It holds no
 * upload code itself, so the page's first bundle stays small.
 */
export class AttachmentDrafts {
  constructor(target = typeof window === "undefined" ? null : window) {
    this.entries = new Map();
    this.target = target;
    this.listening = false;
  }
  // `key` names the chat with its route (owner or user), so no two chats share one;
  // `create()` makes its draft (agent-attachment-drafts.js) on the first visit.
  entry(key, create) {
    let draft = this.entries.get(key);
    if (!draft) {
      draft = create();
      this.entries.set(key, draft);
    }
    this.listen();
    return draft;
  }
  // An empty draft no chat shows any more is dropped; a later visit starts a new one.
  release(key) {
    const draft = this.entries.get(key);
    if (draft?.idle && !draft.listeners.size) this.entries.delete(key);
  }
  listen() {
    if (this.listening || !this.target) return;
    this.listening = true;
    this.target.addEventListener("pagehide", () => {
      for (const draft of this.entries.values()) draft.leave();
    });
    this.target.addEventListener("pageshow", (event) => {
      if (event.persisted)
        for (const draft of this.entries.values()) draft.forgetStaged();
    });
  }
  // A logout or another user: no chat keeps the previous user's files.
  clearAll() {
    for (const draft of this.entries.values()) draft.abort();
    this.entries.clear();
  }
}
