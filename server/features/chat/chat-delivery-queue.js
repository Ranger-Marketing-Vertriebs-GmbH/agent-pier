import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";

/**
 * Held chat messages per session, delivered strictly in order. A message waits
 * behind an open question, request or menu, and every later message waits
 * behind it, so the chat stays usable without reordering what the CLI gets.
 * Only the session's single worker ever attempts a job, so no message can be
 * written twice. Jobs live in memory; their durable receipts say what a
 * restart interrupted.
 */
export class DeliveryQueue {
  constructor(delivery) {
    this.delivery = delivery;
    this.queues = new Map();
    this.workers = new Set();
    this.wakers = new Map();
  }

  busy(id) {
    return Boolean(this.queues.get(id)?.length);
  }

  find(id, file) {
    return this.queues.get(id)?.find((job) => job.file === file);
  }

  /**
   * Queue a new message. The head of an empty queue is attempted at once by the
   * worker and the response waits for that first outcome; later ones report
   * `waiting: "queue"`.
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
    const first = new Promise((resolve) => (job.attempted = resolve));
    this.run(job.id);
    await first;
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

  finish(job) {
    const queue = this.queues.get(job.id) || [];
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) this.queues.delete(job.id);
    this.delivery.active.delete(job.file);
    job.attempted?.();
    // The next message is due at once, not after the retry interval.
    if (queue.length && !queue[0].started) this.wakers.get(job.id)?.abort();
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

  /** Sleep between retries; a new head interrupts it. Never keeps the process alive. */
  async pause(id) {
    const waker = new AbortController();
    this.wakers.set(id, waker);
    try {
      await sleep(this.delivery.retryMs, undefined, { ref: false, signal: waker.signal });
    } catch {
      /* Woken for a new head. */
    } finally {
      if (this.wakers.get(id) === waker) this.wakers.delete(id);
    }
  }

  run(id) {
    if (this.workers.has(id)) {
      // A new head must not wait for the retry interval of a cancelled one.
      if (!this.queues.get(id)?.[0]?.started) this.wakers.get(id)?.abort();
      return;
    }
    this.workers.add(id);
    this.work(id).finally(() => {
      this.workers.delete(id);
      if (this.busy(id)) this.run(id);
    });
  }

  async work(id) {
    const { delivery } = this;
    for (;;) {
      const job = this.queues.get(id)?.[0];
      if (!job) return;
      if (job.started) {
        await this.pause(id);
        if (this.queues.get(id)?.[0] !== job) continue;
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
      // Cancelled or replaced while this worker waited: never attempt it.
      if (job.cancelled || this.queues.get(id)?.[0] !== job) continue;
      job.started = true;
      job.deadline ??= Date.now() + delivery.waitLimitMs;
      let outcome;
      job.running = delivery.attempt(job);
      try {
        outcome = await job.running;
      } catch {
        // A failed receipt write leaves the durable pending/uncertain state.
        outcome = "failed";
      } finally {
        job.running = null;
      }
      // A cancel that raced this attempt only wins while nothing was pasted.
      if (
        outcome !== "deferred" ||
        (job.cancelled && job.receipt.journal?.phase === "reserved")
      )
        this.finish(job);
      else {
        job.attempted?.();
        if (job.receipt.waiting === "dialog") job.view = await this.view(id);
      }
    }
  }

  /**
   * Cancel a held message while its text has not reached the terminal. The
   * attempt refuses a cancelled job under the session lock before its paste;
   * pasted text can only be removed in the TUI. Returns false when the message
   * was delivered or finished meanwhile.
   */
  async cancel(id, file) {
    const job = this.find(id, file);
    if (!job) return false;
    if (job.mode === "submit" || job.receipt.journal?.phase !== "reserved")
      throw problem(copy.cancelPasted, 409);
    job.cancelled = true;
    if (job.running) await job.running.catch(() => {});
    const { receipt } = job;
    if (receipt.status === "handed-off") return false;
    if (receipt.journal?.phase !== "reserved") {
      job.cancelled = false;
      throw problem(copy.cancelPasted, 409);
    }
    try {
      receipt.status = "rejected";
      receipt.reason = "CHAT_CANCELLED";
      delete receipt.waiting;
      this.delivery.write(file, receipt);
    } finally {
      this.finish(job);
    }
    return true;
  }
}
