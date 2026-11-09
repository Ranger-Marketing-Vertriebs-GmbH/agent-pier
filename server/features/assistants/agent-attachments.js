import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  detectAttachment,
  safeFileName,
} from "./agent-attachment-types.js";
import { attachmentDelivery, conversationFiles } from "./agent-attachment-notes.js";
import { MAX_SHARE_BYTES } from "./agent-share-source.js";
import { SHARED, SharedFiles, fileRequest, playable } from "./agent-share-store.js";
import { dropExpiredImage } from "./hermes-generated-images.js";
import { VideoUploads } from "./agent-video-uploads.js";
import { chatProblem } from "./agent-chats.js";
import { MAX_VIDEO_BYTES, videoExtensions } from "./agent-video-types.js";
import {
  AttachmentStorage,
  MAX_AGENT_BYTES,
  MAX_AGENT_FILES,
} from "./agent-attachment-storage.js";
import {
  checkedChatFolder,
  chatFoldersOf,
  keepsChatFolders,
} from "./chat-file-folders.js";
import { migrateChatFiles } from "./chat-file-migration.js";

// Files picked in the composer but not sent yet; they expire after a day. A page left
// without sending may leave its files behind, so a conversation at the cap gives up
// its oldest unsent files instead of refusing the next one.
const MAX_STAGED = 20;
const STAGED_TTL = 24 * 3600 * 1000;
const FOLDER = "attachments";
const extensions = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/heic": [".heic", ".heif"],
  "application/pdf": [".pdf"],
  ...videoExtensions,
};
const agentId = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const record = (row) => row && { ...JSON.parse(row.body), id: row.id, row };
const publicFile = ({ id, name, type, kind, size, video }) => ({
  id,
  name,
  type,
  kind,
  size,
  ...(video && { video }),
});
const stagedRow =
  "SELECT * FROM agent_attachments WHERE id=? AND conversation_id=? AND request_id IS NULL";
const digest = (body) => createHash("sha256").update(body).digest("hex");
// Staged files a queued message names (queued-messages.js): never expired or removed.
const unqueued =
  "id NOT IN (SELECT j.value FROM queued_messages q, json_each(q.attachments) j)";
// Files an agent shared with the owner (agent-share-store.js) carry `share:<request
// id>` as their request: no delivery or claim ever names one, and no history note or
// upload quota counts one.
const owned = `request_id NOT LIKE '${SHARED}%'`;

/**
 * The owner's chat attachments to agents. Each file is copied into the receiving
 * agent's own workspace (attachments/), or for a Hermes agent into the chat's own
 * file folder (chat-file-folders.js; its rows carry `chat: true`), so only that agent
 * can read it with its tools; the index lives in AgentPier's database, never in the
 * workspace, and the browser only sees ids. Images a model can see also travel
 * inline with the turn.
 */
export class AgentAttachments {
  // `config.workspaces` is the Gateway's workspace root; each agent owns <root>/<id>.
  // `hooks.checked` runs after the folder check, `hooks.clearing` before a checked
  // folder is removed (test seams for the swap race).
  constructor({ store, models, config, now = Date.now, hooks = {} }) {
    Object.assign(this, { store, models, config, now, hooks });
    this.db = store.db;
    this.queues = new Map();
    this.shared = new SharedFiles(this);
    this.videos = new VideoUploads(this);
    this.storage = new AttachmentStorage(this);
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
  // The workspace is checked before anything is created in it, so no folder is ever
  // made through a linked workspace.
  async folder(assistantId, create = true) {
    const root = this.config?.workspaces;
    if (!root || !agentId.test(assistantId)) throw assistantProblem("unavailable", 503);
    const workspace = path.join(root, assistantId);
    const folder = path.join(workspace, FOLDER);
    try {
      const realRoot = await fs.realpath(root);
      if (create)
        await fs.mkdir(workspace, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      const own = await fs.lstat(workspace);
      if (
        !own.isDirectory() ||
        (await fs.realpath(workspace)) !== path.join(realRoot, assistantId)
      )
        throw Error("unsafe");
      if (create)
        await fs.mkdir(folder, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      const [stat, real] = await Promise.all([
        fs.lstat(folder, { bigint: true }),
        fs.realpath(folder),
      ]);
      if (!stat.isDirectory() || real !== path.join(realRoot, assistantId, FOLDER))
        throw Error("unsafe");
      return { path: folder, dev: stat.dev, ino: stat.ino, real };
    } catch (error) {
      if (!create && error.code === "ENOENT") return null;
      throw assistantProblem("attachmentStorageUnsafe", 409);
    }
  }
  // Whether the agent keeps its uploads in per-chat folders (a Hermes agent).
  chatFolders(assistantId) {
    try {
      return keepsChatFolders(this.store.getAssistant(assistantId));
    } catch {
      return false;
    }
  }
  // The checked folder a new upload of the chat is copied into.
  async uploadFolder(conversation) {
    const { assistantId, id } = conversation;
    if (!this.chatFolders(assistantId)) return this.folder(assistantId);
    return {
      ...(await checkedChatFolder(this.config, [assistantId, id], true)),
      chat: true,
    };
  }
  // The checked folder that holds a row's copy, or null while it is missing.
  folderOf(file, create = false) {
    const { assistant_id: assistantId, conversation_id: conversationId } = file.row;
    return file.chat
      ? checkedChatFolder(this.config, [assistantId, conversationId], create)
      : this.folder(assistantId, create);
  }
  // Every checked folder of the agent's uploads: attachments/ (key "") while it is
  // there, and each chat folder (key: the chat id). An unsafe attachments/ is left to
  // the owner's clear.
  async folders(assistantId) {
    const old = await this.folder(assistantId, false).catch(() => null);
    return [
      ...(old ? [{ ...old, key: "" }] : []),
      ...(await chatFoldersOf(this.config, assistantId)),
    ];
  }
  // Moves a Hermes agent's attachments/ into its chat folders (chat-file-migration.js).
  migrate(assistantId) {
    return this.serial(assistantId, () => migrateChatFiles(this, assistantId));
  }
  rows(sql, ...args) {
    return this.db
      .prepare(sql)
      .all(...args)
      .map(record);
  }
  async stage(conversationId, name, body) {
    const conversation = this.store.getConversation(conversationId);
    if (conversation.archivedAt) throw chatProblem("CHAT_ARCHIVED");
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
    const folder = await this.uploadFolder(conversation);
    await this.expire(conversation.assistantId);
    await this.trimStaged(conversation.id);
    await this.assertQuota(conversation.assistantId, body.length);
    const entry = await this.copy(folder, name, body, detected);
    const id = randomUUID();
    try {
      this.index(id, conversation, entry);
    } catch (error) {
      // An unindexed copy would be invisible to the quota and never cleaned up.
      await fs.rm(path.join(folder.path, entry.file), { force: true });
      throw error;
    }
    return publicFile({ id, ...entry });
  }
  // Makes room for one more unsent file in the conversation.
  async trimStaged(conversationId) {
    const staged = this.rows(
      `SELECT * FROM agent_attachments WHERE conversation_id=? AND request_id IS NULL AND ${unqueued} ORDER BY created_at, rowid`,
      conversationId,
    );
    for (const file of staged.slice(0, Math.max(0, staged.length - MAX_STAGED + 1)))
      await this.remove(file);
  }
  // Writes one copy into the checked folder under a stamped, unique name.
  async copy(folder, name, body, detected) {
    const { display, file } = this.storedName(name, detected.type);
    const identity = await this.create(folder, file, body);
    return {
      name: display,
      file,
      size: body.length,
      ...detected,
      ...identity,
      ...(folder.chat && { chat: true }),
    };
  }
  // The display name and the stamped, unique file name of a new copy.
  storedName(name, type) {
    const display = safeFileName(name);
    const wanted = extensions[type];
    const stored =
      wanted && !wanted.includes(path.extname(display).toLowerCase())
        ? `${display}${wanted[0]}`
        : display;
    const stamp = new Date(this.now())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .replace(/\..*$/, "");
    return { display, file: `${stamp}-${randomBytes(4).toString("hex")}-${stored}` };
  }
  index(id, conversation, entry, requestId = null, at = this.now()) {
    this.db
      .prepare(
        "INSERT INTO agent_attachments (id,assistant_id,conversation_id,request_id,body,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        conversation.assistantId,
        conversation.id,
        requestId,
        JSON.stringify(entry),
        at,
      );
  }
  // Files agents hand the owner (agent-share-store.js).
  share(input) {
    return this.shared.share(input);
  }
  sharedFor(conversationId) {
    return this.shared.forConversation(conversationId);
  }
  /**
   * Creates the copy by descriptor. The empty file is created without following a
   * link; only after proving that it is the inode in the checked folder, and that the
   * folder is still the checked directory at its real place, are the bytes written
   * through the descriptor. A folder swapped in between can then receive nothing.
   * Returns the content digest that every later read requires.
   */
  async create(folder, file, body) {
    const handle = await this.createEmpty(folder, file);
    try {
      await handle.writeFile(body);
      return { sha256: digest(body) };
    } catch {
      await fs.rm(path.join(folder.path, file), { force: true });
      throw assistantProblem("attachmentStorageUnsafe", 409);
    } finally {
      await handle.close();
    }
  }
  // The empty, proven file, open for writing; a video receives its chunks through it.
  async createEmpty(folder, file) {
    const target = path.join(folder.path, file);
    let handle;
    try {
      handle = await fs.open(
        target,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw assistantProblem("attachmentStorageUnsafe", 409);
    }
    try {
      await this.hooks.checked?.(folder);
      const own = await handle.stat({ bigint: true });
      const [named, dir, real] = await Promise.all([
        fs.lstat(target, { bigint: true }).catch(() => null),
        fs.lstat(folder.path, { bigint: true }).catch(() => null),
        fs.realpath(folder.path).catch(() => null),
      ]);
      if (
        !named ||
        named.dev !== own.dev ||
        named.ino !== own.ino ||
        // A second link (made while the folder was swapped) would expose the bytes.
        own.nlink !== 1n ||
        dir?.dev !== folder.dev ||
        dir?.ino !== folder.ino ||
        !dir.isDirectory() ||
        real !== folder.real
      ) {
        if (named?.ino === own.ino && named?.dev === own.dev)
          await fs.rm(target, { force: true });
        throw assistantProblem("attachmentStorageUnsafe", 409);
      }
      return handle;
    } catch (error) {
      await handle.close();
      if (error.key === "attachmentStorageUnsafe") throw error;
      await fs.rm(target, { force: true });
      throw assistantProblem("attachmentStorageUnsafe", 409);
    }
  }
  async expire(assistantId) {
    const old = this.rows(
      `SELECT * FROM agent_attachments WHERE assistant_id=? AND request_id IS NULL AND created_at<? AND ${unqueued}`,
      assistantId,
      this.now() - STAGED_TTL,
    );
    for (const file of old) await this.remove(file);
    await this.videos.sweep(assistantId);
  }
  // Removes a row and its copy. A folder no longer safe refuses, and the row stays
  // with its copy until the owner's clear.
  async remove(file) {
    const folder = await this.folderOf(file);
    if (folder) await fs.rm(path.join(folder.path, file.file), { force: true });
    this.db.prepare("DELETE FROM agent_attachments WHERE id=?").run(file.id);
  }
  /**
   * Counts what is really in the agent's folders (bounded, and orphans count too) and
   * drops unsent index rows whose copy is gone, so the index never outgrows the
   * folders. A sent file's row stays, marked gone: the history still recognises the
   * note its message carried, and shows only the files that are left.
   */
  async assertQuota(assistantId, adding) {
    let bytes = adding;
    const present = new Set();
    // Videos still arriving count with the size they announced.
    const arriving = this.videos.arriving(assistantId);
    for (const size of arriving.values()) bytes += size;
    // Streamed, and stopped at the cap: a folder flooded by the agent costs no more.
    for (const folder of await this.folders(assistantId))
      for await (const entry of await fs.opendir(folder.path)) {
        if (present.size + 1 >= MAX_AGENT_FILES)
          throw assistantProblem("attachmentStorageFull", 409);
        if (await dropExpiredImage(folder, entry, this.now())) continue;
        present.add(`${folder.key}/${entry.name}`);
        if (!entry.isFile() || arriving.has(entry.name)) continue;
        bytes +=
          (await fs.lstat(path.join(folder.path, entry.name)).catch(() => null))?.size ||
          0;
      }
    for (const file of this.rows(
      `SELECT * FROM agent_attachments WHERE assistant_id=? AND (request_id IS NULL OR ${owned})`,
      assistantId,
    )) {
      const key = file.chat ? file.row.conversation_id : "";
      if (present.has(`${key}/${file.file}`) || file.gone) continue;
      // A move stopped between its rename and the row's mark (chat-file-migration.js)
      // left the copy in its chat's folder; the next move marks the row.
      if (present.has(`${file.row.conversation_id}/${file.file}`)) continue;
      if (file.row.request_id === null)
        this.db.prepare("DELETE FROM agent_attachments WHERE id=?").run(file.id);
      else this.markGone(file);
    }
    if (bytes > MAX_AGENT_BYTES) throw assistantProblem("attachmentStorageFull", 409);
  }
  markGone(file) {
    this.db
      .prepare("UPDATE agent_attachments SET body=? WHERE id=?")
      .run(JSON.stringify({ ...JSON.parse(file.row.body), gone: true }), file.id);
  }
  async discard(conversationId, id) {
    const conversation = this.store.getConversation(conversationId);
    return this.serial(conversation.assistantId, async () => {
      const [file] = this.rows(stagedRow, id, conversationId);
      if (!file) throw assistantProblem("attachmentNotFound", 404);
      if (this.queued(conversationId).includes(id))
        throw assistantProblem("queuedAttachment", 409);
      await this.remove(file);
    });
  }
  // A draft's staged file, checked when its chat is opened again, starts its day anew;
  // one that expired or whose copy is gone is not available any more.
  async keep(conversationId, id) {
    const { assistantId } = this.store.getConversation(conversationId);
    return this.serial(assistantId, async () => {
      await this.expire(assistantId);
      const [file] = this.rows(stagedRow, id, conversationId);
      const folder = file && (await this.folderOf(file).catch(() => null));
      const copy =
        folder && (await fs.lstat(path.join(folder.path, file.file)).catch(() => null));
      if (!copy?.isFile()) throw assistantProblem("attachmentNotFound", 404);
      this.touch(conversationId, [id]);
      return publicFile(file);
    });
  }
  /**
   * Binds staged uploads to an accepted request, in the caller's transaction. A
   * retried delivery of the same request names the same files; anything else is a
   * conflict or a file that is gone. `existing` marks a request accepted earlier:
   * it can gain no files, since its delivery has already been sent.
   */
  claim(conversationId, ids = [], requestId, existing = false) {
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== "string" || id.length > 100) ||
      new Set(ids).size !== ids.length
    )
      throw assistantProblem("invalid");
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE)
      throw assistantProblem("attachmentTooMany");
    const claimed = this.files(requestId);
    // An accepted request keeps exactly the files it was accepted with.
    if (existing || claimed.length || !ids.length) {
      if (claimed.map((f) => f.id).join() !== ids.join())
        throw assistantProblem("conflict", 409);
      return claimed;
    }
    const staged = ids.map((id) => this.rows(stagedRow, id, conversationId)[0]);
    if (staged.some((file) => !file)) throw assistantProblem("attachmentNotFound", 404);
    ids.forEach((id, position) =>
      this.db
        .prepare("UPDATE agent_attachments SET request_id=?, position=? WHERE id=?")
        .run(requestId, position, id),
    );
    return this.files(requestId);
  }
  // Staged files handed back to the composer start their expiry anew.
  touch(conversationId, ids = []) {
    for (const id of ids)
      this.db
        .prepare(
          "UPDATE agent_attachments SET created_at=? WHERE id=? AND conversation_id=? AND request_id IS NULL",
        )
        .run(this.now(), id, conversationId);
  }
  queued(conversationId) {
    const row = this.db
      .prepare("SELECT attachments FROM queued_messages WHERE conversation_id=?")
      .get(conversationId);
    return row ? JSON.parse(row.attachments) : [];
  }
  // The public form of staged files, in the given order. Strictly, every one must be
  // staged in this conversation; otherwise missing ones are left out.
  staged(conversationId, ids = [], strict = true) {
    const files = ids.map((id) => this.rows(stagedRow, id, conversationId)[0]);
    if (strict && files.some((file) => !file))
      throw assistantProblem("attachmentNotFound", 404);
    return files.filter(Boolean).map(publicFile);
  }
  files(requestId) {
    return this.rows(
      "SELECT * FROM agent_attachments WHERE request_id=? ORDER BY position",
      requestId,
    );
  }
  // The text the agent receives and the images its model sees inline; `byUser` when
  // the request is a restricted user's (agent-attachment-notes.js).
  delivery(request, assistantId, options) {
    return attachmentDelivery(this, request, assistantId, options);
  }
  /** requestId → the public files and the note the agent received with them. */
  forConversation(conversationId) {
    return conversationFiles(this, conversationId);
  }
  // A copy is read only with the bytes that were written: the recorded size and
  // SHA-256, as a regular file with no other hard link. Inode numbers are not used:
  // Linux reuses a freed one at once, and a restore gives every copy a new one.
  async read(assistantId, file) {
    // A shared file is read from the share store, and never once it has expired.
    if (file.shared && this.shared.expired(file))
      throw assistantProblem("attachmentNotFound", 404);
    const folder = await (
      file.shared ? this.shared.folder(assistantId, false) : this.folderOf(file)
    ).catch(() => null);
    if (!folder) throw assistantProblem("attachmentNotFound", 404);
    let handle;
    try {
      handle = await fs.open(
        path.join(folder.path, file.file),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        typeof file.sha256 !== "string" ||
        stat.size !== BigInt(file.size) ||
        file.size > (file.shared ? MAX_SHARE_BYTES : MAX_ATTACHMENT_BYTES)
      )
        throw Error("file");
      const body = await handle.readFile();
      if (body.length !== file.size || digest(body) !== file.sha256) throw Error("file");
      return body;
    } catch {
      throw assistantProblem("attachmentNotFound", 404);
    } finally {
      await handle?.close();
    }
  }
  async content(id) {
    const [file] = this.rows("SELECT * FROM agent_attachments WHERE id=?", String(id));
    if (!file) throw assistantProblem("attachmentNotFound", 404);
    const body = await this.read(file.row.assistant_id, file);
    // Shown in the browser only while the bytes still are the image recorded, within
    // the size caps; anything else is offered as a download.
    const inline =
      file.kind === "image" &&
      file.type !== "image/heic" &&
      detectAttachment(body, file.name)?.type === file.type;
    return { name: file.name, type: file.type, kind: file.kind, inline, body };
  }
  /** When a chat file was added, or null for an unknown one. */
  createdAt(id) {
    const [file] = this.rows("SELECT * FROM agent_attachments WHERE id=?", String(id));
    return file?.row.created_at ?? null;
  }
  /** The request a chat file came with or answers, or null (fileRequest). */
  requestOf(id) {
    const [file] = this.rows("SELECT * FROM agent_attachments WHERE id=?", String(id));
    return fileRequest(file?.row);
  }
  /** The conversation a chat file (attachment or shared file) belongs to, or null. */
  conversationOf(id) {
    const [file] = this.rows("SELECT * FROM agent_attachments WHERE id=?", String(id));
    return file?.row.conversation_id ?? null;
  }
  // For the chat: a video as a verified open file (agent-video-uploads.js), any
  // other attachment as its bytes.
  async serve(id) {
    const [file] = this.rows("SELECT * FROM agent_attachments WHERE id=?", String(id));
    if (file?.kind === "video" && !file.shared)
      return this.videos.open(file.row.assistant_id, file);
    // Shared videos and audio play inline from the share store (agent-share-store.js).
    if (file?.shared && playable(file)) return this.shared.openMedia(file);
    return this.content(id);
  }
  // Whether the agent's model takes images: the fact its compiled provider declares.
  imageInput(assistantId) {
    try {
      return (
        this.models?.imageInput?.(this.store.getAssistant(assistantId).model) ?? null
      );
    } catch {
      return null;
    }
  }
  policy(conversationId) {
    const { assistantId } = this.store.getConversation(conversationId);
    return {
      imageInput: this.imageInput(assistantId),
      maxBytes: MAX_ATTACHMENT_BYTES,
      maxVideoBytes: MAX_VIDEO_BYTES,
      maxFiles: MAX_ATTACHMENTS_PER_MESSAGE,
    };
  }
  // The folder's usage, the owner's clear and purge (agent-attachment-storage.js).
  usage(assistantId) {
    return this.storage.usage(assistantId);
  }
  clear(assistantId) {
    return this.storage.clear(assistantId);
  }
  purge(assistantId) {
    return this.storage.purge(assistantId);
  }
}
