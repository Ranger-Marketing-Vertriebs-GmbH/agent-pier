import { chatAttachmentCopy as copy } from "../../lib/i18n/de/chat.js";
import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { privateDirectory, problem } from "../../lib/storage.js";
import { rasterType } from "./chat-images.js";
import { removeAttachmentTree } from "./chat-attachment-cleanup.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Per-session storage guard, not the per-message cap: the composer enforces 8 per message.
export const MAX_SESSION_ATTACHMENTS = 64;
const EXTENSIONS = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
});

export function accountAttachmentDirectory(dataDir, accountId) {
  return path.join(dataDir, "chat-attachments", accountId);
}
export function attachmentDirectory(dataDir, accountId, sessionId) {
  return path.join(accountAttachmentDirectory(dataDir, accountId), sessionId);
}

/** Owns uploaded chat images: validation, generated names and per-session cleanup. */
export class ChatAttachments {
  constructor({ dataDir, sessions }) {
    this.directory = dataDir
      ? privateDirectory(path.join(dataDir, "chat-attachments"))
      : null;
    this.cleanupRoot = this.directory ? realpathSync(this.directory) : null;
    this.pending = new Map();
    this.sessions = sessions;
  }
  folder(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))
      throw problem(copy.invalidSession);
    return path.join(this.directory, id);
  }

  async serial(id, action) {
    const pending = (this.pending.get(id) || Promise.resolve())
      .catch(() => {})
      .then(action);
    this.pending.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(id) === pending) this.pending.delete(id);
    }
  }

  save(id, name, body) {
    return this.serial(id, () => this.write(id, name, body));
  }

  async write(id, name, body) {
    const session = await this.sessions.get(id);
    const folder = session.attachments?.directory || this.folder(id);
    if (
      session.status !== "running" ||
      session.pipeline?.headless ||
      session.purpose === "login" ||
      session.tool === "shell"
    )
      throw problem(copy.unavailable, 409);
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 180 ||
      /[/\\\x00-\x1f\x7f]/.test(name) ||
      name === "." ||
      name === ".."
    )
      throw problem(copy.invalidName);
    if (!Buffer.isBuffer(body)) throw problem(copy.invalidBody);
    if (body.length > 10 * 1024 * 1024) throw problem(copy.tooLarge, 413);
    const existing = await fs.readdir(folder).catch(() => []);
    if (existing.length >= MAX_SESSION_ATTACHMENTS)
      throw problem(serverMessages.chat.attachmentLimitReached, 409);
    privateDirectory(folder);
    const directory = await fs.mkdtemp(path.join(folder, "file-"));
    const file = path.join(directory, name);
    try {
      await fs.writeFile(file, body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { name, path: file, size: body.length };
  }

  async directoryFor(id) {
    const session = await this.sessions.get(id);
    const directory = session.attachments?.directory;
    // A session started before this feature carries no grant; never fall back into the project.
    if (
      !directory ||
      session.status !== "running" ||
      session.pipeline?.headless ||
      session.purpose === "login" ||
      session.tool === "shell"
    )
      throw problem(serverMessages.chat.attachmentSessionUnavailable, 409);
    return directory;
  }
  store(id, payload) {
    return this.serial(id, () => this.storeImage(id, payload));
  }
  async storeImage(id, payload) {
    const directory = await this.directoryFor(id);
    if (
      !payload ||
      typeof payload.data !== "string" ||
      typeof payload.name !== "string" ||
      !payload.name.trim()
    )
      throw problem(serverMessages.chat.attachmentInvalidPayload);
    const body = Buffer.from(payload.data, "base64");
    if (!body.length) throw problem(serverMessages.chat.attachmentInvalidPayload);
    if (body.length > MAX_ATTACHMENT_BYTES)
      throw problem(serverMessages.chat.attachmentTooLarge, 413);
    const type = rasterType(body);
    if (!type) throw problem(serverMessages.chat.attachmentUnsupportedFormat, 415);
    const existing = await fs.readdir(directory).catch(() => []);
    if (existing.length >= MAX_SESSION_ATTACHMENTS)
      throw problem(serverMessages.chat.attachmentLimitReached, 409);
    // The client name is never a path component: the stored name is generated here.
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    const file = path.join(
      directory,
      `${stamp}-${randomBytes(4).toString("hex")}.${EXTENSIONS[type]}`,
    );
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, body, { mode: 0o600, flag: "wx" });
    } catch {
      throw problem(serverMessages.chat.attachmentWriteFailed, 500);
    }
    return { name: payload.name.slice(0, 200), path: file };
  }
  // For a caller that already removed the session record and so cannot look
  // the directory up by id (see sessions.js: the directory must be captured
  // before deletion is authorized, not after).
  discard(id, directory) {
    return this.serial(id, async () => {
      await this.discardDirectory(id, directory);
      if (this.directory) await this.discardDirectory(id, this.folder(id));
    });
  }
  async discardDirectory(id, directory) {
    if (!this.directory || typeof directory !== "string") return;
    // Only this session's legacy folder or account-scoped folder is owned here.
    const relative = path.relative(this.directory, directory);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79})?$/.test(
        relative,
      )
    )
      return;
    const parts = relative.split(path.sep);
    if (parts.at(-1) !== id) return;
    const root = await fs.realpath(this.directory);
    let actual;
    try {
      actual = await fs.realpath(path.join(this.directory, relative));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    // A linked account or session must never turn cleanup into an external delete.
    if (actual !== path.join(root, relative)) return;
    await removeAttachmentTree(this.cleanupRoot, parts);
  }
}
