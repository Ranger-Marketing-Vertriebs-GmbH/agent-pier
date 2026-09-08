import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat.js";

export const deliveryScope = (session) =>
  JSON.stringify([
    session.id,
    session.accountId,
    session.tool,
    session.createdAt || null,
  ]);
const empty = () => ({
  epoch: "initial",
  revision: 0,
  text: "",
  attachments: [],
  outbox: null,
  recent: [],
  storageError: "",
});
const manifest = (attachments) =>
  attachments.map(({ key, name, path }) => ({ key, name, path }));
const normalized = (text) => text.replaceAll("\r\n", "\n").trim();

// Matching is presentation-only: native text is NOT an acknowledgement of delivery.
// Consume rows once so two identical outgoing messages cannot both match one row.
export function visibleDeliveries(items, messages) {
  const used = new Set();
  return items.filter((item) => {
    const match = messages.find(
      (message) =>
        message.role === "user" &&
        !used.has(message.id) &&
        !item.baselineIds.includes(message.id) &&
        normalized(message.text || "") === normalized(item.text),
    );
    if (!match) return true;
    used.add(match.id);
    return false;
  });
}

function validate(value, scope) {
  if (
    value.version !== 1 ||
    typeof value.text !== "string" ||
    value.text.length > 32000 ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > 8 ||
    value.attachments.some(
      (a) => !a || [a.key, a.name, a.path].some((s) => typeof s !== "string"),
    ) ||
    !Array.isArray(value.recent) ||
    value.recent.length > 20
  )
    throw Error("Invalid draft");
  for (const item of [...value.recent, ...(value.outbox ? [value.outbox] : [])]) {
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.text !== "string" ||
      item.text.length > 32000 ||
      item.scope !== scope ||
      !Array.isArray(item.baselineIds)
    )
      throw Error("Invalid outbox");
  }
  return { ...empty(), ...value, storageError: "" };
}

/** Cross-tab write-ahead store. Await durable enqueue before any POST. */
export class ChatDraft {
  constructor(storage, scope, lock) {
    this.lock = lock;
    this.unsaved = {};
    this.editVersion = 0;
    this.pendingEdits = new Map();
    this.storage = storage;
    this.scope = scope;
    this.key = `agentpier.chat.v1:${scope}`;
    this.journalPrefix = `${this.key}:journal:`;
    // Journal names are not credentials. Older contexts can still retain drafts
    // and show a useful send error when cryptographic message IDs are unavailable.
    this.writer = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.listeners = new Set();
    this.snapshot = empty();
    this.reload();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(value) {
    // Controlled inputs must reflect typing synchronously, even while a previous
    // write waits for another tab. Never overlay edits onto an immutable outbox.
    this.snapshot = { ...value };
    if (!value.outbox)
      for (const patch of this.pendingEdits.values()) Object.assign(this.snapshot, patch);
    for (const listener of this.listeners) listener();
  }
  read() {
    const raw = this.storage.getItem(this.key);
    const saved = raw === null ? empty() : validate(JSON.parse(raw), this.scope);
    if (!saved.outbox) {
      const journals = this.journalKeys().sort();
      for (const key of journals) {
        if (!key.startsWith(`${this.journalPrefix}${saved.epoch}:`)) continue;
        const rawJournal = this.storage.getItem(key);
        if (rawJournal === null) continue;
        const journal = validate(JSON.parse(rawJournal), this.scope);
        if (!Number.isSafeInteger(journal.revision) || journal.revision < 1)
          throw Error("Invalid draft journal");
        if (journal.epoch === saved.epoch && journal.revision > saved.revision) {
          saved.text = journal.text;
          saved.attachments = journal.attachments;
          saved.revision = journal.revision;
        }
      }
    }
    // Completed-file manifests are durable; previews stay in this tab's memory.
    saved.attachments = saved.attachments.map((attachment) => {
      const local = this.snapshot.attachments.find(
        (item) => item.key === attachment.key && item.path === attachment.path,
      );
      return local?.previewUrl
        ? { ...attachment, previewUrl: local.previewUrl }
        : attachment;
    });
    return saved;
  }
  journalKeys() {
    const keys = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (key?.startsWith(this.journalPrefix)) keys.push(key);
    }
    return keys;
  }
  pruneJournals(saved) {
    // Journal keys are immutable per edit: deleting an obsolete key cannot erase
    // a concurrent tab's newer edit, which always receives a different key.
    try {
      for (const key of this.journalKeys()) {
        const journal = JSON.parse(this.storage.getItem(key));
        if (
          journal &&
          (journal.epoch !== saved.epoch || journal.revision <= saved.revision)
        )
          this.storage.removeItem(key);
      }
    } catch {
      /* Cleanup must not turn a durable write into a failed send. */
    }
  }
  adopt(saved) {
    if (saved.outbox) this.unsaved = {};
    this.publish({ ...saved, ...this.unsaved });
  }
  reload = () => {
    try {
      const saved = this.read();
      this.corrupt = false;
      this.adopt(saved);
    } catch {
      this.corrupt = true;
      this.publish({ ...this.snapshot, storageError: copy.storageUnreadable });
    }
  };
  async mutate(operation) {
    if (this.corrupt) return null;
    try {
      if (!this.lock) throw Error("Cross-tab locking unavailable");
      return await this.lock(this.key, () => {
        let saved;
        try {
          saved = this.read();
        } catch {
          this.corrupt = true;
          this.publish({ ...this.snapshot, storageError: copy.storageUnreadable });
          return null;
        }
        return operation(saved);
      });
    } catch {
      this.publish({ ...this.snapshot, storageError: copy.storageFailed });
      return null;
    }
  }
  write(next) {
    if (this.corrupt) return false;
    try {
      this.storage.setItem(
        this.key,
        JSON.stringify({
          ...next,
          version: 1,
          attachments: manifest(next.attachments),
          storageError: "",
        }),
      );
      this.publish({ ...next, storageError: "" });
      this.pruneJournals(next);
      return true;
    } catch {
      this.publish({ ...this.snapshot, storageError: copy.storageFailed });
      return false;
    }
  }
  change(patch) {
    if (this.snapshot.outbox || this.corrupt) return Promise.resolve();
    let current;
    try {
      current = this.read();
    } catch {
      this.corrupt = true;
      this.publish({ ...this.snapshot, storageError: copy.storageUnreadable });
      return Promise.resolve();
    }
    if (current.outbox) {
      this.adopt(current);
      return Promise.resolve();
    }
    const version = ++this.editVersion;
    this.pendingEdits.set(version, patch);
    // A storage event from another tab may still be queued. Preserve its durable
    // fields and overlay only this tab's actual edits before journaling.
    this.publish({ ...current, ...this.unsaved });
    const journal = {
      ...empty(),
      version: 1,
      epoch: current.epoch,
      revision: Math.max(current.revision, this.snapshot.revision) + 1,
      text: this.snapshot.text,
      attachments: manifest(this.snapshot.attachments),
    };
    try {
      // This private, immutable edit record survives immediate reload, even if
      // the asynchronous shared-record lock has not run before page teardown.
      this.storage.setItem(
        `${this.journalPrefix}${journal.epoch}:${this.writer}:${version}`,
        JSON.stringify(journal),
      );
    } catch {
      this.unsaved = { ...this.unsaved, ...patch };
      this.publish({ ...this.snapshot, storageError: copy.storageFailed });
    }
    return this.mutate((saved) => {
      this.pendingEdits.delete(version);
      if (saved.outbox || saved.epoch !== journal.epoch) {
        this.unsaved = {};
        this.adopt(saved);
        return;
      }
      // A queued older callback must commit the newest durable journal, not
      // roll the shared draft back to its own earlier keystroke.
      const edits = saved.revision >= journal.revision ? {} : this.unsaved;
      const next = { ...saved, ...edits };
      if (this.write(next)) this.unsaved = {};
      else {
        this.unsaved = {
          ...this.unsaved,
          ...Object.fromEntries(
            Object.keys(patch).map((key) => [key, this.snapshot[key]]),
          ),
        };
        this.publish({ ...this.snapshot, storageError: copy.storageFailed });
      }
    }).finally(() => this.pendingEdits.delete(version));
  }
  enqueue(id, messages) {
    return this.mutate((saved) => {
      if (saved.outbox) {
        this.adopt(saved);
        return saved.outbox;
      }
      const next = { ...saved, ...this.unsaved };
      const { text, attachments } = next;
      const body = attachments.length
        ? [text.trimEnd(), ...attachments.map((a) => a.path)].filter(Boolean).join("\n")
        : text;
      if (!body.trim() || body.length > 32000) return null;
      const outbox = {
        id,
        text: body,
        displayText: [text, ...attachments.map((a) => `📎 ${a.name}`)]
          .filter(Boolean)
          .join("\n\n"),
        scope: this.scope,
        baselineIds: messages.filter((m) => m.role === "user").map((m) => m.id),
        status: "waiting",
      };
      if (!this.write({ ...next, outbox, epoch: crypto.randomUUID(), revision: 0 }))
        return null;
      this.unsaved = {};
      return outbox;
    });
  }
  receipt(receipt) {
    return this.mutate((saved) => {
      const item = saved.outbox;
      if (!item || item.id !== receipt.deliveryId) {
        this.adopt(saved);
        return;
      }
      if (receipt.status === "handed-off") {
        this.write({
          ...saved,
          text: "",
          attachments: [],
          outbox: null,
          recent: [...saved.recent, { ...item, status: "handed-off", error: "" }].slice(
            -20,
          ),
        });
      } else {
        this.write({
          ...saved,
          outbox: { ...item, status: receipt.status, error: receipt.error || "" },
        });
      }
    });
  }
  restore(id) {
    return this.mutate((saved) => {
      if (
        saved.outbox?.id === id &&
        ["uncertain", "rejected"].includes(saved.outbox.status)
      )
        this.write({ ...saved, outbox: null });
      else this.adopt(saved);
    });
  }
  dismiss(id) {
    return this.mutate((saved) => {
      this.write({
        ...saved,
        recent: saved.recent.filter((item) => item.id !== id),
      });
    });
  }
}
