import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { detectAttachment, safeFileName } from "./agent-attachment-types.js";
import { MAX_SHARE_BYTES } from "./agent-share-source.js";
import { removeChecked, trashFor } from "./agent-attachment-storage.js";
import { VIDEO_HEAD_BYTES, videoType } from "./agent-video-types.js";
import { audioType } from "./agent-audio-types.js";
import { hashFile, identity, reader } from "./agent-video-uploads.js";
import { constants } from "node:fs";

// Files agents shared with the owner, per agent: their own budget beside the owner's
// uploads. Copies expire after 90 days; a full store gives up its oldest ones, whose
// chat messages then say the file is no longer available.
export const MAX_SHARED_BYTES = 1024 * 1024 * 1024;
export const MAX_SHARED_FILES = 2000;
export const SHARED_TTL = 90 * 24 * 3600 * 1000;
const SWEEP_INTERVAL = 3600 * 1000;
// Their index rows carry `share:<request id>` as their request (agent-attachments.js).
export const SHARED = "share:";
const agentId = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const publicFile = ({ id, name, type, kind, size }) => ({ id, name, type, kind, size });
/**
 * The request a chat file belongs to, from its index row: a share names the request
 * whose turn shared it, an upload the request it came with. Null for none, and for a
 * generated image whose asking turn was unknown (`share:image:<artifact>`).
 */
export function fileRequest(row) {
  const value = row?.request_id;
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith(SHARED)) return value;
  const requestId = value.slice(SHARED.length);
  return requestId && !requestId.startsWith("image:") ? requestId : null;
}
const ignoreExisting = (error) => {
  if (error.code !== "EEXIST") throw error;
};

/**
 * The copies of shared files live outside every agent workspace, under
 * `<assistants>/shares/<agent id>/` (mode 0700), so no agent can read back, replace
 * or delete them; the owner's signed-in route serves them by id like uploads. The
 * index shares the attachments table, so backups and the route need nothing new.
 */
// Videos and audio play inline (served a range at a time); images and PDFs keep their
// type; anything else is a download.
const mediaType = (body) => {
  const head = body.subarray(0, VIDEO_HEAD_BYTES);
  const video = videoType(head);
  if (video) return { type: video, kind: "video" };
  const audio = audioType(head);
  return audio ? { type: audio, kind: "audio" } : null;
};
const fileType = (body, name) => {
  const detected = detectAttachment(body, name);
  return detected && detected.kind !== "text"
    ? detected
    : { type: "application/octet-stream", kind: "file" };
};
const MAX_VERIFIED = 256;
export const playable = (file) => ["video", "audio"].includes(file?.kind);

export class SharedFiles {
  constructor(attachments) {
    // Copies proven once by their bytes; Range requests then reuse the proof.
    this.verified = new Map();
    this.checking = new Map();
    this.a = attachments;
    this.swept = 0;
    // A test seam; the app keeps the defaults.
    this.limits = { bytes: MAX_SHARED_BYTES, files: MAX_SHARED_FILES, ttl: SHARED_TTL };
  }
  root() {
    const config = this.a.config;
    if (config?.shares) return config.shares;
    return config?.workspaces
      ? path.join(path.dirname(config.workspaces), "shares")
      : null;
  }
  // The agent's share folder: a real directory in a real shares root, never a link.
  async folder(assistantId, create = true) {
    const root = this.root();
    if (!root || !agentId.test(assistantId)) throw assistantProblem("unavailable", 503);
    const folder = path.join(root, assistantId);
    try {
      if (create) await fs.mkdir(root, { mode: 0o700 }).catch(ignoreExisting);
      const top = await fs.lstat(root);
      const [realRoot, parent] = [
        await fs.realpath(root),
        await fs.realpath(path.dirname(root)),
      ];
      if (!top.isDirectory() || realRoot !== path.join(parent, path.basename(root)))
        throw Error("unsafe");
      if (create) await fs.mkdir(folder, { mode: 0o700 }).catch(ignoreExisting);
      const stat = await fs.lstat(folder, { bigint: true });
      const real = await fs.realpath(folder);
      if (!stat.isDirectory() || real !== path.join(realRoot, assistantId))
        throw Error("unsafe");
      return { path: folder, dev: stat.dev, ino: stat.ino, real };
    } catch (error) {
      if (!create && error.code === "ENOENT") return null;
      throw assistantProblem("attachmentStorageUnsafe", 409);
    }
  }
  rows(where, ...args) {
    return this.a.rows(
      `SELECT * FROM agent_attachments WHERE request_id LIKE '${SHARED}%' AND ${where} ORDER BY created_at, rowid`,
      ...args,
    );
  }
  // The agent's stored copies, oldest first, once each (a mirror row shares one).
  live(assistantId) {
    const seen = new Set();
    return this.rows("assistant_id=?", assistantId).filter(
      (f) => !f.gone && !seen.has(f.file) && seen.add(f.file),
    );
  }
  expired(file) {
    return file.row.created_at < this.a.now() - this.limits.ttl;
  }
  // Removes one copy; every message that showed it says it is gone.
  async drop(assistantId, folder, file) {
    if (folder) await fs.rm(path.join(folder.path, file), { force: true });
    for (const row of this.rows("assistant_id=?", assistantId))
      if (row.file === file && !row.gone)
        this.a.db
          .prepare("UPDATE agent_attachments SET body=? WHERE id=?")
          .run(JSON.stringify({ ...JSON.parse(row.row.body), gone: true }), row.id);
  }
  // Expired copies go, then the oldest until `adding` bytes and one more file fit.
  async retain(assistantId, folder, adding = 0) {
    let live = this.live(assistantId);
    for (const file of live.filter((f) => this.expired(f)))
      await this.drop(assistantId, folder, file.file);
    live = live.filter((f) => !this.expired(f));
    let bytes = live.reduce((sum, f) => sum + f.size, 0);
    while (
      live.length &&
      (live.length + (adding ? 1 : 0) > this.limits.files ||
        bytes + adding > this.limits.bytes)
    ) {
      const oldest = live.shift();
      bytes -= oldest.size;
      await this.drop(assistantId, folder, oldest.file);
    }
  }
  /**
   * Stores a file an agent hands the owner (agent-shares.js) for the chat of the turn
   * that shared it. Images and PDFs keep their type; any other file is a download.
   * `mirror` (`{ conversationId, from }`) shows a member's file in its lead's chat as
   * well, from the same copy. A generated image (generated-images.js) names its
   * Gateway `artifactId`, stored once per conversation, and the time `at` its message
   * was written, so the chat shows it in place.
   */
  async share({
    conversation,
    requestId,
    name,
    body,
    caption = "",
    mirror = null,
    artifactId = null,
    at = null,
  }) {
    if (!Buffer.isBuffer(body) || !body.length) throw assistantProblem("shareEmpty");
    if (body.length > MAX_SHARE_BYTES) throw assistantProblem("shareTooLarge", 413);
    const owner = conversation.assistantId;
    return this.a.serial(`share:${owner}`, async () => {
      const known = artifactId && this.artifact(conversation.id, artifactId);
      if (known) return publicFile(known);
      const now = this.a.now();
      const when = Number.isFinite(at) && at <= now && at > now - 86400000 ? at : now;
      const typed = mediaType(body) || fileType(body, name);
      const folder = await this.folder(owner);
      await this.retain(owner, folder, body.length);
      const entry = {
        ...(await this.a.copy(folder, name, body, typed)),
        shared: true,
        ...(caption ? { caption } : {}),
        ...(artifactId ? { artifactId } : {}),
      };
      const id = randomUUID();
      try {
        this.a.transaction(() => {
          this.a.index(id, conversation, entry, SHARED + requestId, when);
          if (mirror)
            this.a.index(
              randomUUID(),
              { assistantId: owner, id: mirror.conversationId },
              { ...entry, from: mirror.from },
              SHARED + requestId,
              when,
            );
        });
      } catch (error) {
        await fs.rm(path.join(folder.path, entry.file), { force: true });
        throw error;
      }
      return publicFile({ id, ...entry });
    });
  }
  /**
   * Records a generated image that could not be copied (gone, too large, no image):
   * its chat shows it as no longer available, and it is never tried again.
   */
  unavailable({ conversation, requestId, name, mirror = null, artifactId, at = null }) {
    if (this.artifact(conversation.id, artifactId)) return;
    const now = this.a.now();
    const when = Number.isFinite(at) && at <= now && at > now - 86400000 ? at : now;
    const entry = {
      name: safeFileName(name),
      type: "application/octet-stream",
      kind: "file",
      size: 0,
      shared: true,
      artifactId,
      gone: true,
      failed: true,
    };
    this.a.transaction(() => {
      this.a.index(randomUUID(), conversation, entry, SHARED + requestId, when);
      if (mirror)
        this.a.index(
          randomUUID(),
          { assistantId: conversation.assistantId, id: mirror.conversationId },
          { ...entry, from: mirror.from },
          SHARED + requestId,
          when,
        );
    });
  }
  /** The file a conversation already holds for a Gateway artifact, or null. */
  artifact(conversationId, artifactId) {
    return (
      this.rows(
        "conversation_id=? AND json_extract(body, '$.artifactId')=?",
        conversationId,
        String(artifactId),
      )[0] || null
    );
  }
  /**
   * The files agents shared in a conversation, as agent messages at the time each
   * was shared; a copy that is gone or expired keeps its message, marked
   * `unavailable`.
   */
  forConversation(conversationId) {
    return this.rows("conversation_id=?", conversationId).map((file) => {
      const gone = file.gone || this.expired(file);
      return {
        id: `shared-file:${file.id}`,
        role: "assistant",
        text: typeof file.caption === "string" ? file.caption : "",
        timestamp: file.row.created_at,
        runId: null,
        // The request whose turn shared it: the owner's opt-in window hides what
        // answers a message from before it (owner-privacy.js).
        requestId: fileRequest(file.row),
        shared: true,
        attachments: gone ? [] : [publicFile(file)],
        ...(gone ? { unavailable: true } : {}),
        ...(typeof file.from === "string" ? { from: file.from } : {}),
      };
    });
  }
  /** The owner deletes a shared file from the chat it shows in (and every other). */
  async remove(conversationId, id) {
    const [file] = this.rows("id=? AND conversation_id=?", String(id), conversationId);
    if (!file || file.gone) throw assistantProblem("attachmentNotFound", 404);
    const owner = file.row.assistant_id;
    await this.a.serial(`share:${owner}`, async () =>
      this.drop(owner, await this.folder(owner, false), file.file),
    );
  }
  /** At most hourly: every agent's expired copies go. */
  async sweep() {
    if (this.a.now() - this.swept < SWEEP_INTERVAL) return;
    this.swept = this.a.now();
    const owners = new Set(
      this.rows("created_at<?", this.a.now() - this.limits.ttl)
        .filter((f) => !f.gone)
        .map((f) => f.row.assistant_id),
    );
    // One agent's unsafe folder keeps only its own copies; the others still go.
    for (const owner of owners)
      await this.a
        .serial(`share:${owner}`, async () =>
          this.retain(owner, await this.folder(owner, false)),
        )
        .catch(() => {});
  }
  /**
   * A shared video or audio file opened for range reads: the copy must still be the
   * bytes recorded (size and SHA-256, checked once per file identity) and of its type.
   */
  async openMedia(file) {
    if (this.expired(file) || file.gone)
      throw assistantProblem("attachmentNotFound", 404);
    const folder = await this.folder(file.row.assistant_id, false);
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
        file.size > MAX_SHARE_BYTES
      )
        throw Error("file");
      const key = identity(stat);
      if (this.verified.get(file.id) !== key) {
        // Safari asks for many ranges at once: one check per file identity runs.
        const check = `${file.id}|${key}`;
        if (!this.checking.has(check))
          this.checking.set(
            check,
            (async () => {
              const typed = mediaType(await reader(handle)(0, VIDEO_HEAD_BYTES));
              return (
                typed?.type === file.type &&
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
        kind: file.kind,
        inline: true,
        size: file.size,
        handle,
      };
    } catch {
      await handle?.close();
      throw assistantProblem("attachmentNotFound", 404);
    }
  }
  /** Removes an agent's shared copies; see AgentAttachments.purge. */
  async purge(assistantId) {
    const folder = await this.folder(assistantId, false);
    if (folder)
      await removeChecked(folder, trashFor(this.root()), `${assistantId}-shares`);
  }
}
