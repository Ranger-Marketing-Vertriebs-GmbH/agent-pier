import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import {
  INLINE_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  attachmentNote,
  detectAttachment,
  safeFileName,
} from "./agent-attachment-types.js";

// Files picked in the composer but not sent yet; they expire after a day.
const MAX_STAGED = 20;
const STAGED_TTL = 24 * 3600 * 1000;
// Per agent; counted over the copies still present in its workspace.
const MAX_AGENT_BYTES = 512 * 1024 * 1024;
const MAX_AGENT_FILES = 1000;
const FOLDER = "attachments";
const extensions = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/heic": [".heic", ".heif"],
  "application/pdf": [".pdf"],
};
const agentId = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const record = (row) => row && { ...JSON.parse(row.body), id: row.id, row };
const publicFile = ({ id, name, type, kind, size }) => ({ id, name, type, kind, size });
const agentPath = (file) => `${FOLDER}/${file.file}`;

/**
 * The owner's chat attachments to agents. Each file is copied into the receiving
 * agent's own workspace (attachments/), so only that agent can read it with its
 * tools; the index lives in AgentPier's database, never in the workspace, and the
 * browser only sees ids. Images a model can see also travel inline with the turn.
 */
export class AgentAttachments {
  // `config.workspaces` is the Gateway's workspace root; each agent owns <root>/<id>.
  constructor({ store, models, config, now = Date.now }) {
    Object.assign(this, { store, models, config, now });
    this.db = store.db;
    this.queues = new Map();
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  serial(key, action) {
    const next = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }
  // The agent's attachments folder: a real directory inside its own real workspace.
  async folder(assistantId, create = true) {
    const root = this.config?.workspaces;
    if (!root || !agentId.test(assistantId)) throw assistantProblem("unavailable", 503);
    const workspace = path.join(root, assistantId);
    const folder = path.join(workspace, FOLDER);
    try {
      if (create) await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
      if (create)
        await fs.mkdir(folder, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      const [own, real] = await Promise.all([fs.lstat(folder), fs.realpath(folder)]);
      const expected = path.join(await fs.realpath(root), assistantId, FOLDER);
      if (!own.isDirectory() || real !== expected) throw Error("unsafe");
    } catch (error) {
      if (!create && error.code === "ENOENT") return null;
      throw assistantProblem("attachmentStorageUnsafe", 409);
    }
    return folder;
  }
  rows(sql, ...args) {
    return this.db
      .prepare(sql)
      .all(...args)
      .map(record);
  }
  async stage(conversationId, name, body) {
    const conversation = this.store.getConversation(conversationId);
    return this.serial(conversation.assistantId, () =>
      this.write(conversation, name, body),
    );
  }
  async write(conversation, name, body) {
    if (!Buffer.isBuffer(body) || !body.length) throw assistantProblem("invalid");
    if (body.length > MAX_ATTACHMENT_BYTES)
      throw assistantProblem("attachmentTooLarge", 413);
    const detected = detectAttachment(body, name);
    if (!detected) throw assistantProblem("attachmentUnsupported", 415);
    const folder = await this.folder(conversation.assistantId);
    await this.expire(conversation.assistantId, folder);
    const staged = this.rows(
      "SELECT * FROM agent_attachments WHERE conversation_id=? AND request_id IS NULL",
      conversation.id,
    );
    if (staged.length >= MAX_STAGED) throw assistantProblem("attachmentTooMany", 409);
    await this.assertQuota(conversation.assistantId, folder, body.length);
    const display = safeFileName(name);
    const wanted = extensions[detected.type];
    const stored =
      wanted && !wanted.includes(path.extname(display).toLowerCase())
        ? `${display}${wanted[0]}`
        : display;
    const stamp = new Date(this.now())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .replace(/\..*$/, "");
    const file = `${stamp}-${randomBytes(4).toString("hex")}-${stored}`;
    try {
      await fs.writeFile(path.join(folder, file), body, { flag: "wx", mode: 0o600 });
    } catch {
      throw assistantProblem("attachmentStorageUnsafe", 409);
    }
    const entry = { name: display, file, size: body.length, ...detected };
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO agent_attachments (id,assistant_id,conversation_id,body,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        id,
        conversation.assistantId,
        conversation.id,
        JSON.stringify(entry),
        this.now(),
      );
    return publicFile({ id, ...entry });
  }
  async expire(assistantId, folder) {
    const old = this.rows(
      "SELECT * FROM agent_attachments WHERE assistant_id=? AND request_id IS NULL AND created_at<?",
      assistantId,
      this.now() - STAGED_TTL,
    );
    for (const file of old) await this.remove(file, folder);
  }
  async remove(file, folder) {
    await fs.rm(path.join(folder, file.file), { force: true });
    this.db.prepare("DELETE FROM agent_attachments WHERE id=?").run(file.id);
  }
  async assertQuota(assistantId, folder, adding) {
    let bytes = adding,
      count = 1;
    for (const file of this.rows(
      "SELECT * FROM agent_attachments WHERE assistant_id=?",
      assistantId,
    )) {
      const stat = await fs.lstat(path.join(folder, file.file)).catch(() => null);
      if (!stat?.isFile()) continue;
      bytes += stat.size;
      count++;
    }
    if (bytes > MAX_AGENT_BYTES || count > MAX_AGENT_FILES)
      throw assistantProblem("attachmentStorageFull", 409);
  }
  async discard(conversationId, id) {
    const conversation = this.store.getConversation(conversationId);
    return this.serial(conversation.assistantId, async () => {
      const [file] = this.rows(
        "SELECT * FROM agent_attachments WHERE id=? AND conversation_id=? AND request_id IS NULL",
        id,
        conversationId,
      );
      if (!file) throw assistantProblem("attachmentNotFound", 404);
      await this.remove(file, await this.folder(conversation.assistantId));
    });
  }
  /**
   * Binds staged uploads to an accepted request, in the caller's transaction. A
   * retried delivery of the same request names the same files; anything else is a
   * conflict or a file that is gone.
   */
  claim(conversationId, ids = [], requestId) {
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== "string" || id.length > 100) ||
      new Set(ids).size !== ids.length
    )
      throw assistantProblem("invalid");
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE)
      throw assistantProblem("attachmentTooMany");
    const claimed = this.files(requestId);
    if (claimed.length || !ids.length) {
      if (claimed.map((f) => f.id).join() !== ids.join())
        throw assistantProblem("conflict", 409);
      return claimed;
    }
    const staged = ids.map(
      (id) =>
        this.rows(
          "SELECT * FROM agent_attachments WHERE id=? AND conversation_id=? AND request_id IS NULL",
          id,
          conversationId,
        )[0],
    );
    if (staged.some((file) => !file)) throw assistantProblem("attachmentNotFound", 404);
    ids.forEach((id, position) =>
      this.db
        .prepare("UPDATE agent_attachments SET request_id=?, position=? WHERE id=?")
        .run(requestId, position, id),
    );
    return this.files(requestId);
  }
  files(requestId) {
    return this.rows(
      "SELECT * FROM agent_attachments WHERE request_id=? ORDER BY position",
      requestId,
    );
  }
  // The text the agent receives and the images its model sees inline.
  async delivery(request, assistantId) {
    const files = this.files(request.id);
    if (!files.length) return { message: request.text };
    const note = attachmentNote(files.map((f) => ({ ...f, path: agentPath(f) })));
    const message = request.text.trim() ? `${request.text}\n\n${note}` : note;
    const attachments = [];
    if (this.imageInput(assistantId) === false) return { message };
    let total = 0;
    for (const file of files) {
      if (
        !INLINE_IMAGE_TYPES.has(file.type) ||
        file.size > MAX_INLINE_IMAGE_BYTES ||
        total + file.size > MAX_INLINE_TOTAL_BYTES
      )
        continue;
      const body = await this.read(assistantId, file).catch(() => null);
      if (!body) continue;
      total += body.length;
      attachments.push({
        type: "image",
        mimeType: file.type,
        fileName: file.name,
        content: body.toString("base64"),
      });
    }
    return attachments.length ? { message, attachments } : { message };
  }
  // A copy is read only as a regular file inside the agent's real folder.
  async read(assistantId, file) {
    const folder = await this.folder(assistantId, false);
    if (!folder) throw assistantProblem("attachmentNotFound", 404);
    let handle;
    try {
      handle = await fs.open(
        path.join(folder, file.file),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw Error("file");
      return await handle.readFile();
    } catch {
      throw assistantProblem("attachmentNotFound", 404);
    } finally {
      await handle?.close();
    }
  }
  /** requestId → the public files and the note the agent received with them. */
  forConversation(conversationId) {
    const byRequest = new Map();
    for (const file of this.rows(
      "SELECT * FROM agent_attachments WHERE conversation_id=? AND request_id IS NOT NULL ORDER BY request_id, position",
      conversationId,
    )) {
      const entry = byRequest.get(file.row.request_id) || { files: [] };
      entry.files.push(file);
      byRequest.set(file.row.request_id, entry);
    }
    for (const entry of byRequest.values()) {
      entry.note = attachmentNote(entry.files.map((f) => ({ ...f, path: agentPath(f) })));
      entry.files = entry.files.map(publicFile);
    }
    return byRequest;
  }
  async content(id) {
    const [file] = this.rows("SELECT * FROM agent_attachments WHERE id=?", String(id));
    if (!file) throw assistantProblem("attachmentNotFound", 404);
    const body = await this.read(file.row.assistant_id, file);
    return { name: file.name, type: file.type, kind: file.kind, body };
  }
  /**
   * Whether the agent's model takes images. Endpoint models declare it; OpenRouter
   * transports are compiled without an input list, which the runtime treats as
   * text-only; ChatGPT accounts run OpenAI's multimodal models. Null when unknown.
   */
  imageInput(assistantId) {
    try {
      const { connectionId, modelId } = this.store.getAssistant(assistantId).model || {};
      if (String(connectionId).startsWith("openclaw:")) return true;
      const connection = this.models?.connections?.get(connectionId);
      if (connection?.providerId === "openrouter") return false;
      if (connection?.providerId === "endpoint")
        return (
          connection.endpoint?.models?.find((m) => m.modelId === modelId)?.images === true
        );
    } catch {
      /* Unknown below. */
    }
    return null;
  }
  policy(conversationId) {
    const { assistantId } = this.store.getConversation(conversationId);
    return {
      imageInput: this.imageInput(assistantId),
      maxBytes: MAX_ATTACHMENT_BYTES,
      maxFiles: MAX_ATTACHMENTS_PER_MESSAGE,
    };
  }
  /** Removes an agent's copies and their index, for when the agent itself goes. */
  purge(assistantId) {
    return this.serial(assistantId, async () => {
      const folder = await this.folder(assistantId, false);
      if (folder) await fs.rm(folder, { recursive: true, force: true });
      this.db
        .prepare("DELETE FROM agent_attachments WHERE assistant_id=?")
        .run(assistantId);
    });
  }
}
