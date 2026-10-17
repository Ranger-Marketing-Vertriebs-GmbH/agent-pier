import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { detectAttachment } from "./agent-attachment-types.js";
import { MAX_SHARE_BYTES } from "./agent-share-source.js";

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
const ignoreExisting = (error) => {
  if (error.code !== "EEXIST") throw error;
};

/**
 * The copies of shared files live outside every agent workspace, under
 * `<assistants>/shares/<agent id>/` (mode 0700), so no agent can read back, replace
 * or delete them; the owner's signed-in route serves them by id like uploads. The
 * index shares the attachments table, so backups and the route need nothing new.
 */
export class SharedFiles {
  constructor(attachments) {
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
   * well, from the same copy.
   */
  async share({ conversation, requestId, name, body, caption = "", mirror = null }) {
    if (!Buffer.isBuffer(body) || !body.length) throw assistantProblem("shareEmpty");
    if (body.length > MAX_SHARE_BYTES) throw assistantProblem("shareTooLarge", 413);
    const owner = conversation.assistantId;
    return this.a.serial(`share:${owner}`, async () => {
      const detected = detectAttachment(body, name);
      const typed =
        detected && detected.kind !== "text"
          ? detected
          : { type: "application/octet-stream", kind: "file" };
      const folder = await this.folder(owner);
      await this.retain(owner, folder, body.length);
      const entry = {
        ...(await this.a.copy(folder, name, body, typed)),
        shared: true,
        ...(caption ? { caption } : {}),
      };
      const id = randomUUID();
      try {
        this.a.transaction(() => {
          this.a.index(id, conversation, entry, SHARED + requestId);
          if (mirror)
            this.a.index(
              randomUUID(),
              { assistantId: owner, id: mirror.conversationId },
              { ...entry, from: mirror.from },
              SHARED + requestId,
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
  /** Removes an agent's shared copies; see AgentAttachments.purge. */
  async purge(assistantId) {
    const folder = await this.folder(assistantId, false);
    if (folder) await fs.rm(folder.path, { recursive: true, force: true });
  }
}
