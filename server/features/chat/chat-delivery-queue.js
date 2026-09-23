import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";

/**
 * Held chat messages per session, delivered strictly in order. A message waits
 * behind an open question, request or menu, and every later message waits
 * behind it, so the chat stays usable without reordering what the CLI gets.
 * Jobs live in memory; their durable receipts say what a restart interrupted.
 */
export class DeliveryQueue {
  constructor(delivery) {
    this.delivery = delivery;
    this.queues = new Map();
    this.workers = new Set();
  }

  busy(id) {
    return Boolean(this.queues.get(id)?.length);
  }

  find(id, file) {
    return this.queues.get(id)?.find((job) => job.file === file);
  }

  /**
   * Queue a new message. The head of an empty queue is attempted at once, so the
   * response carries its outcome; later ones report `waiting: "queue"`.
   */
  async submit(job) {
    const queue = this.queue(job.id);
    queue.push(job);
    if (queue.length > 1) {
      job.receipt.waiting = "queue";
      job.receipt.reason = "CHAT_QUEUED";
      this.delivery.write(job.file, job.receipt);
      return;
    }
    const outcome = await this.step(job);
    if (outcome === "deferred") job.started = true;
    else this.finish(job);
    this.run(job.id);
  }

  /** A job that already made its first attempt elsewhere (recovery). */
  hold(job) {
    job.started = true;
    this.queue(job.id).push(job);
    this.run(job.id);
  }

  queue(id) {
    if (!this.queues.has(id)) this.queues.set(id, []);
    return this.queues.get(id);
  }

  async step(job) {
    job.running = this.delivery.attempt(job);
    try {
      return await job.running;
    } finally {
      job.running = null;
    }
  }

  finish(job) {
    const queue = this.queues.get(job.id) || [];
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) this.queues.delete(job.id);
    this.delivery.active.delete(job.file);
  }

  /** The screen as plain text, read without the session lock. */
  async view(id) {
    const { sessions } = this.delivery;
    if (typeof sessions.tmux !== "function" || typeof sessions.target !== "function")
      return null;
    return sessions
      .tmux(["capture-pane", "-p", "-t", `${sessions.target(id)}:0.0`])
      .catch(() => null);
  }

  async run(id) {
    if (this.workers.has(id)) return;
    this.workers.add(id);
    const { delivery } = this;
    try {
      for (;;) {
        const job = this.queues.get(id)?.[0];
        if (!job) return;
        if (job.started) {
          // A held message never keeps the process alive on its own.
          await sleep(delivery.retryMs, undefined, { ref: false });
          if (job.cancelled) continue;
          if (!fs.existsSync(job.file)) {
            this.finish(job);
            continue;
          }
          if (Date.now() > job.deadline) {
            // Truthful end: nothing typed is rejected, pasted text stays uncertain.
            job.receipt.status = job.mode === "submit" ? "uncertain" : "rejected";
            delete job.receipt.waiting;
            delivery.write(job.file, job.receipt);
            this.finish(job);
            continue;
          }
          if (job.receipt.waiting === "request" && delivery.requests.hasPending(id))
            continue;
          // A menu or question still on an unchanged screen: leave the session
          // lock (and terminal typing) alone until something moves.
          if (job.receipt.waiting === "dialog") {
            const view = await this.view(id);
            if (view !== null && view === job.view) continue;
            job.view = view;
          }
        }
        job.started = true;
        job.deadline ??= Date.now() + delivery.waitLimitMs;
        let outcome;
        try {
          outcome = await this.step(job);
        } catch {
          // A failed receipt write leaves the durable pending/uncertain state.
          outcome = "failed";
        }
        if (outcome !== "deferred") this.finish(job);
        else if (job.receipt.waiting === "dialog") job.view = await this.view(id);
      }
    } finally {
      this.workers.delete(id);
      if (this.busy(id)) this.run(id);
    }
  }

  /**
   * Cancel a held message while its text has not reached the terminal. Pasted
   * text can only be removed in the TUI.
   */
  async cancel(id, file) {
    const job = this.find(id, file);
    if (!job) return false;
    if (job.running) await job.running.catch(() => {});
    if (!this.find(id, file)) return false;
    if (job.mode === "submit" || job.receipt.journal?.phase !== "reserved")
      throw problem(copy.cancelPasted, 409);
    job.cancelled = true;
    job.receipt.status = "rejected";
    job.receipt.reason = "CHAT_CANCELLED";
    delete job.receipt.waiting;
    this.delivery.write(file, job.receipt);
    this.finish(job);
    return true;
  }
}
