import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import {
  MAX_VIDEO_BYTES,
  VIDEO_CHUNK_BYTES,
  VIDEO_HEAD_BYTES,
  videoMetadata,
  videoType,
} from "./agent-video-types.js";

// An upload nobody continues is given up after this long, its partial copy removed.
const IDLE_MS = 10 * 60 * 1000;
// Uploads one agent may have open. An upload without a chunk for this long gives
// its slot to a new one (a page left mid-upload); active ones are never dropped.
const MAX_OPEN_PER_AGENT = 3;
const ACTIVE_MS = 2 * 60 * 1000;
// A finished upload's id still names its staged file this long, so a retried last
// chunk whose reply was lost gets the file instead of an error.
const FINISHED_MS = 10 * 60 * 1000;
const MAX_FINISHED = 200;
// The names AgentPier gives its copies (storedName in agent-attachments.js).
const STAMPED = /^\d{8}-\d{6}-[0-9a-f]{8}-/;
const uploadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Videos whose bytes were proven against their digest, by id: the file's identity
// then. Range requests (Safari asks for many) need not hash 200 MB each time.
const MAX_VERIFIED = 256;
const READ_BYTES = 1024 * 1024;

const reader = (handle) => async (offset, length) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
};
const identity = (stat) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

async function hashFile(handle, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(Math.min(READ_BYTES, Math.max(1, size)));
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

/**
 * Videos the owner sends an agent (agent-video-types.js). They arrive in chunks:
 * the first names the file and its size and must start with a video container;
 * the copy is created like every attachment copy (create() in agent-attachments.js,
 * O_EXCL|O_NOFOLLOW, proven before a byte is written) and the chunks are written
 * through that descriptor at their offsets. Nothing holds a whole video in memory.
 * Only the completed, checked copy is indexed as a staged attachment.
 */
export class VideoUploads {
  constructor(attachments) {
    this.a = attachments;
    this.uploads = new Map();
    this.verified = new Map();
    this.checking = new Map();
    this.finished = new Map();
  }
  /**
   * Removes copies a crash or restart left half-written: AgentPier-named regular
   * files in the folder with no index row, no upload still writing them, and
   * untouched for the idle time. The caller holds the agent's serial queue.
   */
  async sweep(assistantId, folder) {
    const indexed = new Set(
      this.a.db
        .prepare("SELECT body FROM agent_attachments WHERE assistant_id=?")
        .all(assistantId)
        .map((row) => JSON.parse(row.body).file),
    );
    const arriving = this.arriving(assistantId);
    const cutoff = Date.now() - IDLE_MS;
    let seen = 0;
    for await (const entry of await fs.opendir(folder)) {
      if (++seen > 5000) break;
      if (!entry.isFile() || !STAMPED.test(entry.name)) continue;
      if (indexed.has(entry.name) || arriving.has(entry.name)) continue;
      const target = path.join(folder, entry.name);
      const stat = await fs.lstat(target).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.rm(target, { force: true });
    }
  }
  /** At startup: every agent's leftovers, before anything counts them. */
  async sweepAll() {
    for (const { id } of this.a.store.listAssistants())
      await this.a
        .serial(id, async () => {
          const folder = await this.a.folder(id, false);
          if (folder) await this.sweep(id, folder.path);
        })
        .catch(() => {});
  }
  /** Maintenance (backup, restore, update): no partial copy may outlive it. */
  async dropAll() {
    for (const upload of [...this.uploads.values()])
      await this.drop(upload).catch(() => {});
  }
  // The staged file a finished upload produced, while it is still staged.
  done(conversationId, id) {
    const entry = this.finished.get(String(id));
    if (!entry || entry.conversationId !== conversationId) return null;
    if (Date.now() - entry.at > FINISHED_MS) {
      this.finished.delete(String(id));
      return null;
    }
    return this.a.staged(conversationId, [entry.fileId], false)[0] || null;
  }
  /** fileName → announced size of the videos still arriving for an agent. */
  arriving(assistantId) {
    const sizes = new Map();
    for (const upload of this.uploads.values())
      if (upload.assistantId === assistantId) sizes.set(upload.file, upload.size);
    return sizes;
  }
  /** Starts an upload from the first bytes of the video; `size` is its full length. */
  // `id` is chosen by the page, so a first chunk whose reply was lost can be sent
  // again: an upload already started continues, a finished one names its file.
  async begin(conversationId, name, size, head, id = randomUUID()) {
    if (!uploadId.test(String(id))) throw assistantProblem("invalid");
    const file = this.done(conversationId, id);
    if (file) return { file };
    const existing = this.uploads.get(id);
    if (existing) {
      if (existing.conversationId !== conversationId)
        throw assistantProblem("conflict", 409);
      return { upload: id, received: existing.written };
    }
    if (!Number.isSafeInteger(size) || size < 1) throw assistantProblem("invalid");
    if (size > MAX_VIDEO_BYTES) throw assistantProblem("videoTooLarge", 413);
    const type = videoType(head);
    if (!type) throw assistantProblem("attachmentUnsupported", 415);
    const conversation = this.a.store.getConversation(conversationId);
    const { assistantId } = conversation;
    return this.a.serial(assistantId, async () => {
      const folder = await this.a.folder(assistantId);
      await this.a.expire(assistantId, folder.path);
      if (this.uploads.has(id)) throw assistantProblem("conflict", 409);
      const open = [...this.uploads.values()].filter(
        (u) => u.assistantId === assistantId,
      );
      const now = Date.now();
      for (const stale of open.filter((u) => !u.busy && now - u.touched > ACTIVE_MS))
        if (open.length >= MAX_OPEN_PER_AGENT) {
          await this.drop(stale);
          open.splice(open.indexOf(stale), 1);
        }
      if (open.length >= MAX_OPEN_PER_AGENT)
        throw assistantProblem("videoUploadsBusy", 429);
      await this.a.assertQuota(assistantId, folder.path, size);
      const { display, file } = this.a.storedName(name, type);
      const handle = await this.a.createEmpty(folder, file);
      const upload = {
        id,
        conversationId,
        assistantId,
        folder,
        file,
        name: display,
        type,
        size,
        written: 0,
        hash: createHash("sha256"),
        handle,
        busy: false,
      };
      this.uploads.set(upload.id, upload);
      this.idle(upload);
      return { upload: upload.id, received: 0 };
    });
  }
  idle(upload) {
    upload.touched = Date.now();
    clearTimeout(upload.timer);
    upload.timer = setTimeout(() => void this.drop(upload).catch(() => {}), IDLE_MS);
    upload.timer.unref?.();
  }
  get(conversationId, id) {
    const upload = this.uploads.get(String(id));
    if (!upload || upload.conversationId !== conversationId)
      throw assistantProblem("attachmentNotFound", 404);
    return upload;
  }
  /**
   * Writes one chunk (an async iterable of buffers) at `offset`, which must be
   * where the copy ends. A chunk cut off midway keeps what arrived: the reply to
   * the retry names the offset to continue from.
   */
  async receive(conversationId, id, offset, chunks) {
    const file = this.done(conversationId, id);
    if (file) return { complete: true, file };
    const upload = this.get(conversationId, id);
    if (upload.busy) throw assistantProblem("conflict", 409);
    if (offset !== upload.written)
      throw Object.assign(assistantProblem("videoUploadOffset", 409), {
        received: upload.written,
      });
    upload.busy = true;
    this.idle(upload);
    let count = 0;
    try {
      for await (const chunk of chunks) {
        count += chunk.length;
        if (count > VIDEO_CHUNK_BYTES || upload.written + chunk.length > upload.size) {
          await this.drop(upload);
          throw assistantProblem("videoTooLarge", 413);
        }
        for (let done = 0; done < chunk.length;) {
          const { bytesWritten } = await upload.handle.write(
            chunk,
            done,
            chunk.length - done,
            upload.written + done,
          );
          done += bytesWritten;
        }
        upload.hash.update(chunk);
        upload.written += chunk.length;
      }
    } catch (error) {
      // Removed or expired while the chunk arrived.
      if (this.uploads.get(upload.id) !== upload && !error.key)
        throw assistantProblem("attachmentNotFound", 404);
      throw error;
    } finally {
      upload.busy = false;
    }
    return {
      upload: upload.id,
      received: upload.written,
      complete: upload.written === upload.size,
    };
  }
  /** Checks the completed copy and stages it; resolves with its public record. */
  async finish(conversationId, id) {
    const upload = this.get(conversationId, id);
    if (upload.busy || upload.written !== upload.size)
      throw assistantProblem("conflict", 409);
    this.uploads.delete(upload.id);
    clearTimeout(upload.timer);
    return this.a.serial(upload.assistantId, async () => {
      const target = path.join(upload.folder.path, upload.file);
      // Like any upload, a finished video gives way to none: the oldest unsent
      // files of the conversation do (agent-attachments.js).
      await this.a.trimStaged(upload.conversationId, upload.folder.path);
      let meta;
      try {
        await this.proven(upload, target);
        const read = reader(upload.handle);
        if (videoType(await read(0, VIDEO_HEAD_BYTES)) !== upload.type)
          throw Error("type");
        meta = await videoMetadata(upload.type, read, upload.size);
      } catch (error) {
        await this.discard(upload, target);
        throw error.key ? error : assistantProblem("attachmentStorageUnsafe", 409);
      }
      if (!meta) {
        await this.discard(upload, target);
        throw assistantProblem("attachmentUnsupported", 415);
      }
      await upload.handle.close();
      const entry = {
        name: upload.name,
        file: upload.file,
        size: upload.size,
        type: upload.type,
        kind: "video",
        sha256: upload.hash.digest("hex"),
        ...(Object.keys(meta).length && { video: meta }),
      };
      const fileId = randomUUID();
      try {
        this.a.index(fileId, { ...upload, id: upload.conversationId }, entry);
      } catch (error) {
        await fs.rm(target, { force: true });
        throw error;
      }
      this.finished.set(upload.id, {
        conversationId: upload.conversationId,
        fileId,
        at: Date.now(),
      });
      if (this.finished.size > MAX_FINISHED)
        this.finished.delete(this.finished.keys().next().value);
      const { name, type, kind, size, video } = entry;
      return { id: fileId, name, type, kind, size, ...(video && { video }) };
    });
  }
  // The open descriptor is still the one file at its name in the checked folder.
  async proven(upload, target) {
    const own = await upload.handle.stat({ bigint: true });
    const [named, dir, real] = await Promise.all([
      fs.lstat(target, { bigint: true }).catch(() => null),
      fs.lstat(upload.folder.path, { bigint: true }).catch(() => null),
      fs.realpath(upload.folder.path).catch(() => null),
    ]);
    if (
      !named ||
      named.dev !== own.dev ||
      named.ino !== own.ino ||
      own.nlink !== 1n ||
      own.size !== BigInt(upload.size) ||
      dir?.dev !== upload.folder.dev ||
      dir?.ino !== upload.folder.ino ||
      real !== upload.folder.real
    )
      throw assistantProblem("attachmentStorageUnsafe", 409);
  }
  // Removes a partial copy, but only while its name still is that copy.
  async discard(upload, target) {
    try {
      const own = await upload.handle.stat({ bigint: true });
      const named = await fs.lstat(target, { bigint: true }).catch(() => null);
      if (named && named.dev === own.dev && named.ino === own.ino)
        await fs.rm(target, { force: true });
    } catch {
      /* The handle is already closed; nothing is removed by name alone. */
    }
    await upload.handle.close().catch(() => {});
  }
  async drop(upload) {
    if (this.uploads.get(upload.id) !== upload) return;
    this.uploads.delete(upload.id);
    clearTimeout(upload.timer);
    await this.discard(upload, path.join(upload.folder.path, upload.file));
  }
  /** The owner removed the file before it finished. */
  async cancel(conversationId, id) {
    await this.drop(this.get(conversationId, id));
  }
  /**
   * A staged or sent video, open for reading: a regular file with no other link,
   * the recorded size, and bytes that hash to the recorded digest (checked once
   * per file identity). The caller closes `handle`.
   */
  async open(assistantId, file) {
    const folder = await this.a.folder(assistantId, false);
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
        file.size > MAX_VIDEO_BYTES
      )
        throw Error("file");
      const key = identity(stat);
      if (this.verified.get(file.id) !== key) {
        const check = `${file.id}|${key}`;
        if (!this.checking.has(check))
          this.checking.set(
            check,
            (async () => {
              const head = await reader(handle)(0, VIDEO_HEAD_BYTES);
              return (
                videoType(head) === file.type &&
                (await hashFile(handle, file.size)) === file.sha256
              );
            })().finally(() => this.checking.delete(check)),
          );
        if (!(await this.checking.get(check))) throw Error("file");
        this.verified.delete(file.id);
        this.verified.set(file.id, key);
        if (this.verified.size > MAX_VERIFIED)
          this.verified.delete(this.verified.keys().next().value);
      }
      return {
        name: file.name,
        type: file.type,
        kind: "video",
        inline: true,
        size: file.size,
        handle,
      };
    } catch {
      await handle?.close();
      throw assistantProblem("attachmentNotFound", 404);
    }
  }
}
