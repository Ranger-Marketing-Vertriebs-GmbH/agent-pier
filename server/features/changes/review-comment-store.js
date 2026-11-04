// Review comments per session or run: one private JSON file per scope. Every call
// reads, changes and writes synchronously, so calls never interleave.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { privateDirectory, problem, readJSON, writePrivate } from "../../lib/storage.js";
import { validId } from "../sessions/session-validation.js";
import { runId } from "../pipelines/run-store.js";
import { MAX_COMMENT_BYTES } from "./review-comment-input.js";

export { MAX_COMMENT_BYTES };
export const MAX_OPEN_COMMENTS = 200;
export const MAX_RESOLVED_COMMENTS = 300;

/** @typedef {import("./review-anchor.js").Comment} Comment */
/** @typedef {{ kind: "session" | "run", id: string }} Scope */

const STATUSES = new Set(["open", "resolved"]);

function scopeFile(dataDir, scope) {
  const kind = scope?.kind;
  if (kind !== "session" && kind !== "run")
    throw problem(serverMessages.changes.invalidComment, 400);
  const id = kind === "session" ? validId(scope.id) : runId(scope.id);
  return path.join(dataDir, "review-comments", `${kind}-${id}.json`);
}

export class ReviewCommentStore {
  constructor({ dataDir, onChange = () => {}, now = () => new Date() }) {
    this.dataDir = dataDir;
    this.onChange = onChange;
    this.now = now;
  }

  #read(scope) {
    const data = readJSON(scopeFile(this.dataDir, scope), null);
    const comments = Array.isArray(data?.comments) ? data.comments : [];
    const batches = Number.isSafeInteger(data?.batches) ? data.batches : 0;
    return { comments, batches };
  }

  #write(scope, state) {
    const file = scopeFile(this.dataDir, scope);
    privateDirectory(path.dirname(file));
    writePrivate(file, state);
    this.onChange({ kind: scope.kind, id: scope.id });
  }

  #find(state, id) {
    const comment = state.comments.find((c) => c.id === id);
    if (!comment) throw problem(serverMessages.changes.commentNotFound, 404);
    return comment;
  }

  #stamp() {
    return this.now().toISOString();
  }

  /** @returns {{ comments: Comment[], batches: number }} oldest first */
  list(scope) {
    return this.#read(scope);
  }

  /** @returns {Comment} */
  create(scope, input) {
    const state = this.#read(scope);
    this.#checkOpen(state);
    const at = this.#stamp();
    const comment = {
      id: randomUUID(),
      workspace: input.workspace,
      file: input.file,
      side: input.side,
      line: input.line,
      anchor: input.anchor,
      body: input.body,
      status: "open",
      createdAt: at,
      updatedAt: at,
      sentIn: null,
    };
    state.comments.push(comment);
    this.#write(scope, state);
    return comment;
  }

  /** @returns {Comment} */
  update(scope, id, patch) {
    const state = this.#read(scope);
    const comment = this.#find(state, id);
    const next = { ...comment };
    if (patch.body !== undefined) {
      if (typeof patch.body !== "string" || !patch.body.trim())
        throw problem(serverMessages.changes.invalidComment, 400);
      if (new TextEncoder().encode(patch.body).length > MAX_COMMENT_BYTES)
        throw problem(serverMessages.changes.commentTooLong, 400);
      next.body = patch.body;
    }
    if (patch.status !== undefined) {
      if (!STATUSES.has(patch.status))
        throw problem(serverMessages.changes.invalidComment, 400);
      if (patch.status === "open" && comment.status !== "open") this.#checkOpen(state);
      next.status = patch.status;
    }
    next.updatedAt = this.#stamp();
    state.comments[state.comments.indexOf(comment)] = next;
    this.#pruneResolved(state);
    this.#write(scope, state);
    return next;
  }

  remove(scope, id) {
    const state = this.#read(scope);
    this.#find(state, id);
    state.comments = state.comments.filter((c) => c.id !== id);
    this.#write(scope, state);
  }

  /**
   * Raises the batch counter and marks those open comments as sent in it. An empty
   * list sends no batch: the counter and the file stay as they are.
   */
  markSent(scope, ids) {
    const state = this.#read(scope);
    if (ids.length === 0) return { batch: state.batches };
    const batch = state.batches + 1;
    const wanted = new Set(ids);
    for (const c of state.comments)
      if (c.status === "open" && wanted.has(c.id)) c.sentIn = batch;
    state.batches = batch;
    this.#write(scope, state);
    return { batch };
  }

  // A removal hook must never fail on a comment file: log and go on.
  discardQuietly(scope) {
    try {
      this.discard(scope);
    } catch (error) {
      console.warn(`Review comments of ${scope.kind} ${scope.id} not removed:`, error);
    }
  }

  discard(scope) {
    const file = scopeFile(this.dataDir, scope);
    if (!fs.existsSync(file)) return;
    fs.rmSync(file, { force: true });
    this.onChange({ kind: scope.kind, id: scope.id });
  }

  #checkOpen(state) {
    const open = state.comments.filter((c) => c.status === "open").length;
    if (open >= MAX_OPEN_COMMENTS)
      throw problem(serverMessages.changes.tooManyOpenComments, 409);
  }

  // Drops the oldest resolved comments (by updatedAt) beyond the limit.
  #pruneResolved(state) {
    const resolved = state.comments.filter((c) => c.status === "resolved");
    const excess = resolved.length - MAX_RESOLVED_COMMENTS;
    if (excess <= 0) return;
    const drop = new Set(
      resolved
        .toSorted((a, b) =>
          a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0,
        )
        .slice(0, excess)
        .map((c) => c.id),
    );
    state.comments = state.comments.filter((c) => !drop.has(c.id));
  }
}
