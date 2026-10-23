import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";
import {
  MAX_FILES,
  fileProblem,
  isImage,
  isVideo,
  preparedFile,
} from "./agent-attachment-upload.js";

let nextKey = 0;
const previewTypes = /^image\/(?:jpeg|png|webp|gif)$/;
const empty = Object.freeze({ items: Object.freeze([]), error: "" });

/**
 * The files picked for the next message of one agent chat. Each file is uploaded as
 * soon as it is picked, so sending only names the server's ids. The draft lives in the
 * page, not in the composer: leaving the chat keeps its files (and lets running
 * uploads finish), like the text draft; a reload or a closed tab discards them.
 *
 * `transport` reaches the server for this chat: `upload(file, signal, progress)`,
 * `preview(file)`, `discard(id)`, `keep(id)` and `leave(id)` (a request that outlives
 * the page).
 */
export class AttachmentDraft {
  constructor(transport) {
    this.transport = transport;
    this.state = empty;
    this.listeners = new Set();
    this.controllers = new Map();
    this.queue = Promise.resolve();
  }
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;
  get items() {
    return this.state.items;
  }
  set(values) {
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }
  update(change) {
    this.set({ items: change(this.state.items) });
  }
  patch(key, values) {
    this.update((list) =>
      list.map((item) => (item.key === key ? { ...item, ...values } : item)),
    );
  }
  has(key) {
    return this.items.some((item) => item.key === key);
  }

  add(files) {
    const picked = [...(files || [])];
    if (!picked.length) return;
    this.set({ error: "" });
    let room = MAX_FILES - this.items.length;
    for (const original of picked) {
      if (room <= 0) {
        this.set({ error: copy.tooMany(MAX_FILES) });
        break;
      }
      const problem = fileProblem(original);
      if (problem) {
        this.set({ error: problem });
        continue;
      }
      room--;
      const item = {
        key: `attachment-${++nextKey}`,
        name: original.name,
        size: original.size,
        image: isImage(original),
        video: isVideo(original),
        status: "uploading",
        progress: 0,
      };
      this.update((list) => [...list, item]);
      // One upload at a time keeps the order and stays inside the server's budget.
      this.queue = this.queue.then(async () => {
        if (!this.has(item.key)) return;
        const file = await preparedFile(original);
        // A data URL: the preview outlives the upload and the composer, and needs no
        // revoking.
        if (item.image && previewTypes.test(file.type)) {
          const previewUrl = await this.transport.preview(file).catch(() => undefined);
          if (this.has(item.key)) this.patch(item.key, { previewUrl, name: file.name });
        }
        await this.upload(item, file);
      });
    }
  }

  async upload(item, file) {
    if (!this.has(item.key)) return;
    const controller = new AbortController();
    this.controllers.set(item.key, controller);
    try {
      const stored = await this.transport.upload(file, controller.signal, (progress) =>
        this.patch(item.key, { progress }),
      );
      if (controller.signal.aborted) return;
      this.patch(item.key, { status: "ready", id: stored.id, name: stored.name });
    } catch (e) {
      if (!controller.signal.aborted)
        this.patch(item.key, { status: "failed", error: e.message || copy.failed });
    } finally {
      this.controllers.delete(item.key);
    }
  }

  remove(key) {
    const item = this.items.find((entry) => entry.key === key);
    if (!item) return;
    this.controllers.get(key)?.abort();
    this.update((list) => list.filter((entry) => entry.key !== key));
    if (item.id) this.transport.discard(item.id).catch(() => {});
  }

  // After a successful send: the server now owns the sent files as part of the
  // message. Files picked while it was on its way stay for the next one.
  sent(ids) {
    const gone = new Set(ids);
    this.set({ items: this.items.filter((item) => !gone.has(item.id)), error: "" });
  }

  // A queued message taken back brings its files, still staged on the server.
  restore(files) {
    this.update((list) => [
      ...files
        .filter((file) => !list.some((item) => item.id === file.id))
        .map((file) => ({
          key: `attachment-${++nextKey}`,
          id: file.id,
          name: file.name,
          size: file.size,
          image: file.kind === "image",
          video: file.kind === "video",
          status: "ready",
          progress: 1,
        })),
      ...list,
    ]);
  }

  /**
   * Back in the chat: files staged earlier start their expiry anew, and one the
   * server no longer has (expired or cleared) says so and waits to be removed.
   */
  async check() {
    const ready = this.items.filter((item) => item.status === "ready" && item.id);
    for (const item of ready)
      try {
        await this.transport.keep(item.id);
      } catch (e) {
        const current = this.items.find((entry) => entry.key === item.key);
        if (e?.status === 404 && current?.id === item.id)
          this.patch(item.key, { status: "failed", error: e.message || copy.failed });
      }
  }

  // An error about the last pick belongs to that visit of the chat.
  forgetError() {
    if (this.state.error) this.set({ error: "" });
  }

  // A reload or a closed tab: the server forgets these files as the page goes.
  leave() {
    for (const item of this.items) if (item.id) this.transport.leave(item.id);
  }

  // A page restored from the back-forward cache lost its staged files on the server.
  forgetStaged() {
    if (this.items.some((item) => item.id))
      this.update((list) => list.filter((item) => !item.id));
  }

  get idle() {
    return !this.items.length && !this.controllers.size;
  }

  abort() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.state = empty;
    for (const listener of this.listeners) listener();
  }
}
