import { nativeInputQueue } from "./native-input-queue.js";
import fs from "node:fs";
import { normalizeChatText } from "../sessions/session-chat-input.js";
import {
  deliveryReason,
  heldMode,
  intents,
  noticeRecorder,
  provenPhase,
  reasonText,
  recoverDelivery,
  waitingFor,
} from "./chat-delivery-recovery.js";
import { DeliveryQueue } from "./chat-delivery-queue.js";
import { composerProblem } from "../sessions/claude-composer.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDirectory, problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";
import {
  requireChatInput,
  requireCurrentChatInput,
} from "../../application/request-input-guard.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set(["pending", "handed-off", "rejected", "uncertain"]);
function sessionScope(session) {
  return JSON.stringify([
    session.id,
    session.deliveryAccountId || session.accountId,
    session.tool,
    session.createdAt || null,
  ]);
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Durable at-most-once native input for one owner of the data directory. */
export class ChatDelivery {
  constructor({ dataDir, sessions, requests, models, retryMs = 1000, waitLimitMs }) {
    this.directory = path.join(dataDir, "chat-delivery");
    this.sessions = sessions;
    this.requests = requests;
    this.models = models;
    this.active = new Set();
    // An open question may take a while to answer; keep waiting for 12 hours.
    this.retryMs = retryMs;
    this.waitLimitMs = waitLimitMs ?? 12 * 60 * 60 * 1000;
    this.held = new DeliveryQueue(this);
  }

  folder(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))
      throw problem(copy.invalid);
    return path.join(this.directory, id);
  }

  file(id, deliveryId) {
    if (typeof deliveryId !== "string" || !uuid.test(deliveryId))
      throw problem(copy.invalid);
    return path.join(this.folder(id), `${deliveryId.toLowerCase()}.json`);
  }

  checkScope(session, scope) {
    if (typeof scope !== "string" || scope !== sessionScope(session))
      throw problem(copy.scope, 409);
  }

  read(file) {
    try {
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        !receipt ||
        receipt.version !== 1 ||
        !uuid.test(receipt.deliveryId) ||
        typeof receipt.scope !== "string" ||
        !/^[0-9a-f]{64}$/.test(receipt.hash) ||
        !statuses.has(receipt.status) ||
        path.basename(file) !== `${receipt.deliveryId}.json`
      )
        throw new Error("Invalid receipt");
      return receipt;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw problem(copy.storage, 503);
    }
  }

  write(file, receipt) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      privateDirectory(this.directory);
      syncDirectory(path.dirname(this.directory));
      privateDirectory(path.dirname(file));
      syncDirectory(this.directory);
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(receipt) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      syncDirectory(path.dirname(file));
    } catch {
      throw problem(copy.storage, 503);
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* Keep original error. */
      }
    }
  }

  result(receipt, file) {
    const status = this.active.has(file)
      ? "pending"
      : receipt.status === "pending"
        ? "uncertain"
        : receipt.status;
    return {
      deliveryId: receipt.deliveryId,
      status,
      attemptId: receipt.attemptId || receipt.deliveryId,
      ...(receipt.observation ? { observation: receipt.observation } : {}),
      ...(receipt.recovery ? { recovery: receipt.recovery } : {}),
      ...(receipt.notices?.length ? { notices: receipt.notices } : {}),
      ...(status === "pending" && receipt.waiting ? { waiting: receipt.waiting } : {}),
      ...(status === "rejected" ? { error: copy.rejected } : {}),
      ...(status === "uncertain" ? { error: copy.uncertain } : {}),
      // Whether the text may sit in the TUI prompt selects the reason wording.
      ...(["uncertain", "pending"].includes(status)
        ? { pasted: !["reserved", undefined].includes(receipt.journal?.phase) }
        : {}),
      ...(["rejected", "uncertain"].includes(status) && receipt.reason
        ? {
            reason: receipt.reason,
            error: reasonText(
              receipt.reason,
              status === "uncertain" && receipt.journal?.phase === "reserved"
                ? "rejected"
                : status,
            ),
          }
        : {}),
    };
  }

  async status(id, deliveryId, scope) {
    const file = this.file(id, deliveryId);
    this.checkScope(await this.sessions.get(id), scope);
    const receipt = this.read(file);
    if (!receipt) return { deliveryId: deliveryId.toLowerCase(), status: "absent" };
    if (receipt.scope !== scope) throw problem(copy.scope, 409);
    return this.result(receipt, file);
  }

  async send(id, body) {
    const { deliveryId, deliveryScope, text, submit } = body;
    const file = this.file(id, deliveryId);
    if (typeof text !== "string" || text.length > 32000 || submit !== true)
      throw problem(copy.invalid);
    this.checkScope(await this.sessions.get(id), deliveryScope);
    const hash = createHash("sha256")
      .update(JSON.stringify([text, submit]))
      .digest("hex");
    const previous = this.read(file);
    if (previous) {
      if (previous.scope !== deliveryScope || previous.hash !== hash)
        throw problem(copy.conflict, 409);
      return this.result(previous, file);
    }
    let normalized;
    try {
      normalized = normalizeChatText(text);
    } catch {
      /* Persist a rejection so the draft stays editable. */
    }
    const receipt = {
      version: 1,
      deliveryId: deliveryId.toLowerCase(),
      scope: deliveryScope,
      hash,
      status: "pending",
      attemptId: deliveryId.toLowerCase(),
      journal: { phase: "reserved" },
    };
    // No await between lookup, durable reservation and in-process ownership.
    if (normalized === undefined) {
      receipt.status = "rejected";
      this.write(file, receipt);
      return this.result(receipt, file);
    }
    this.write(file, receipt);
    this.active.add(file);
    // Messages reach the TUI in order; a held one keeps later ones behind it.
    // The response reports "pending" while the message waits.
    await this.held.submit({
      id,
      file,
      receipt,
      text: normalized,
      hash,
      scope: deliveryScope,
    });
    return this.result(receipt, file);
  }

  /** Cancel a held message before its text reached the terminal. */
  async cancel(id, deliveryId, scope) {
    const file = this.file(id, deliveryId);
    this.checkScope(await this.sessions.get(id), scope);
    const receipt = this.read(file);
    if (!receipt) throw problem(copy.unknownDelivery, 404);
    if (receipt.scope !== scope) throw problem(copy.scope, 409);
    // A message that was delivered or finished meanwhile reports that outcome.
    await this.held.cancel(id, file);
    return this.result(this.read(file), file);
  }

  /**
   * One terminal handoff under the session lock. Returns "deferred" when an open
   * question, native request or menu keeps the message pending; the receipt then
   * records what it waits for and the phase its text reached.
   */
  async attempt(job) {
    const { id, file, receipt, text, hash, scope } = job;
    const submitOnly = job.mode === "submit";
    // Image chips were pasted before a hold: only their text is still due.
    const resume = job.mode === "text";
    let mayHaveWritten = submitOnly || resume;
    try {
      if (!mayHaveWritten) await requireChatInput(this.requests, id);
      const refuseCancelled = () => {
        if (job.cancelled) throw composerProblem("CHAT_CANCELLED");
      };
      await this.sessions.withChatInput(id, async (tx) => {
        this.checkScope(tx.session, scope);
        // A cancel is checked under the session lock, before any key or paste.
        refuseCancelled();
        if (!mayHaveWritten) {
          receipt.journal = { phase: "reserved", generation: tx.recoveryGeneration };
          receipt.observation = {
            generation: tx.observationGeneration,
            startedAt: Date.now(),
            providerSessionId: tx.providerSessionId || null,
            hash,
            baseline: nativeInputQueue(tx.session.tool, tx.raw, tx.pane),
          };
          this.write(file, receipt);
        }
        requireCurrentChatInput(this.requests, id);
        // Claude's own /model picker is a menu closed before the paste.
        await this.models.guardInput(id, tx.session, tx.raw, {
          nativeMenus: tx.session.tool === "claude",
        });
        await tx.write(text, {
          allowComposerDraft: !submitOnly && !resume,
          submitOnly,
          ...(resume ? { resume: "text" } : {}),
          // The prompt box as seen right after the paste: Enter follows a hold
          // only while it is unchanged, also for appended or multi-line text.
          promptProof: job.proof,
          onProof: (proof) => (job.proof = proof),
          // Escape a menu once per message, never again while waiting.
          closeMenus: !receipt.notices?.includes("CHAT_DIALOG_CLOSED"),
          onPhase: async (phase) => {
            if (phase === "paste-intent") refuseCancelled();
            if (intents.has(phase)) requireCurrentChatInput(this.requests, id);
            receipt.status = "uncertain";
            receipt.journal = { phase, generation: tx.recoveryGeneration };
            this.write(file, receipt);
            mayHaveWritten = true;
          },
          onRefused: async (phase) => {
            receipt.journal = {
              phase: provenPhase[phase],
              generation: tx.recoveryGeneration,
            };
            this.write(file, receipt);
            if (phase === "paste-intent") mayHaveWritten = false;
          },
          onNotice: noticeRecorder(receipt),
        });
      });
      receipt.status = "handed-off";
      delete receipt.waiting;
      delete receipt.reason;
    } catch (error) {
      const reason = deliveryReason(error);
      const waiting = waitingFor(reason);
      const phase = mayHaveWritten ? receipt.journal?.phase : "reserved";
      if (waiting && heldMode[phase]) {
        // Only what the journal proves missing follows: never a second paste.
        job.mode = heldMode[phase];
        receipt.waiting = waiting;
        receipt.reason = reason;
        if (this.exists(file)) this.write(file, receipt);
        return "deferred";
      }
      receipt.status = mayHaveWritten ? "uncertain" : "rejected";
      delete receipt.waiting;
      // Never keep the reason of an earlier hold for a different outcome.
      if (reason) receipt.reason = reason;
      else delete receipt.reason;
    }
    if (this.exists(file)) this.write(file, receipt);
    return receipt.status;
  }

  exists(file) {
    return fs.existsSync(file);
  }

  recover(id, deliveryId, body) {
    return recoverDelivery(this, id, deliveryId, body);
  }

  async discard(id) {
    fs.rmSync(this.folder(id), { recursive: true, force: true });
  }
}
