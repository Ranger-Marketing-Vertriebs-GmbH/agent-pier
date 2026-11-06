import { nativeInputQueue } from "./native-input-queue.js";
import fs from "node:fs";
import { normalizeChatText } from "../sessions/session-chat-input.js";
import {
  deliveryReason,
  enterMaySent,
  heldMode,
  intents,
  noticeRecorder,
  provenPhase,
  reasonText,
  recoverDelivery,
  waitingFor,
} from "./chat-delivery-recovery.js";
import { commandCleared, unconfirmedCommand } from "./delivery-commands.js";
import { DeliveryQueue } from "./chat-delivery-queue.js";
import { clearBlockedPrompt, rejectBlocked } from "./chat-delivery-blocked.js";
import { composerProblem } from "../sessions/claude-composer.js";
import { claudeImageMessage } from "../sessions/claude-image-paste.js";
import { isNativeSlashCommand } from "../sessions/session-slash-command.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDirectory, problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";
import {
  requireChatInput,
  requireCurrentChatInput,
} from "../../application/request-input-guard.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set(["pending", "handed-off", "rejected", "uncertain", "accepted"]);
// Receipts a native acceptance event may still confirm.
const confirmable = new Set(["handed-off", "uncertain"]);
// Delivered texts kept for a hook block; the matcher bounds expectations alike.
const MAX_BLOCKABLE = 256;
/** The scope a delivery is bound to: the session and the CLI and account it runs. */
export function sessionScope(session) {
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

/** Turn a handed-off or uncertain receipt into accepted; false when it is not. */
function confirm(receipt, outcome) {
  if (!confirmable.has(receipt.status)) return false;
  receipt.status = "accepted";
  receipt.acceptedAt = Date.now();
  if (outcome.queued !== undefined) receipt.queued = outcome.queued;
  delete receipt.reason;
  delete receipt.waiting;
  return true;
}

/** Durable at-most-once native input for one owner of the data directory. */
export class ChatDelivery {
  constructor({
    dataDir,
    sessions,
    requests,
    models,
    retryMs = 1000,
    waitLimitMs,
    onChange,
    acceptance,
  }) {
    this.directory = path.join(dataDir, "chat-delivery");
    // Told the session id of every receipt write (session.deliveries live topic).
    this.onChange = onChange;
    this.waiters = new Set();
    this.sessions = sessions;
    this.requests = requests;
    this.models = models;
    this.active = new Set();
    // An open question may take a while to answer; keep waiting for 12 hours.
    this.retryMs = retryMs;
    this.waitLimitMs = waitLimitMs ?? 12 * 60 * 60 * 1000;
    this.held = new DeliveryQueue(this);
    // Matches native acceptance events of the CLI to deliveries (see accept()).
    this.acceptance = acceptance;
    // Acceptances that arrived while their delivery still ran, by receipt file.
    this.earlyAcceptance = new Map();
    // The text of each delivery awaiting its event, by receipt file: a hook
    // block clears the CLI prompt box only while it shows exactly this text.
    this.blockable = new Map();
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
    this.changed(path.basename(path.dirname(file)));
  }

  /**
   * Resolves with the receipt's `status()` shape once it is no longer pending,
   * handed-off or uncertain (accepted, hook-blocked, rejected), or with the current
   * result at `timeoutMs`. Woken by receipt writes, never polling.
   */
  settled(id, deliveryId, { timeoutMs = 8000 } = {}) {
    const file = this.file(id, deliveryId);
    const read = () => {
      const receipt = this.read(file);
      return receipt
        ? this.result(receipt, file)
        : { deliveryId: deliveryId.toLowerCase(), status: "absent" };
    };
    const open = (result) =>
      ["pending", "handed-off", "uncertain"].includes(result.status);
    const first = read();
    if (!open(first)) return Promise.resolve(first);
    return new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(result);
      };
      const waiter = { id, check: () => open(read()) || done(read()) };
      const timer = setTimeout(() => done(read()), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** A delivery of session `id` changed; a failing listener is logged, never thrown. */
  changed(id) {
    for (const waiter of [...this.waiters]) if (waiter.id === id) waiter.check();
    try {
      this.onChange?.(id);
    } catch {
      console.error("AgentPier could not report a chat delivery change.");
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
      ...(receipt.confirmation ? { confirmation: receipt.confirmation } : {}),
      ...(receipt.command ? { command: true } : {}),
      ...(receipt.submittedAt ? { submittedAt: receipt.submittedAt } : {}),
      ...(status === "accepted"
        ? {
            acceptedAt: receipt.acceptedAt,
            ...(receipt.queued !== undefined ? { queued: receipt.queued } : {}),
          }
        : {}),
      ...(status === "pending" && receipt.waiting ? { waiting: receipt.waiting } : {}),
      ...(status === "rejected" ? { error: copy.rejected } : {}),
      // A hook-blocked message: its text is back in the composer when released.
      ...(status === "rejected" && receipt.released !== undefined
        ? { released: receipt.released }
        : {}),
      ...(status === "rejected" && receipt.hookReason
        ? { hookReason: receipt.hookReason }
        : {}),
      ...(status === "uncertain" ? { error: copy.uncertain } : {}),
      // Whether the text may sit in the TUI prompt selects the reason wording.
      ...(["uncertain", "pending"].includes(status)
        ? {
            // "images": only the image chips of the message are in the prompt.
            pasted:
              receipt.journal?.phase === "images-pasted"
                ? "images"
                : !["reserved", undefined].includes(receipt.journal?.phase),
          }
        : {}),
      ...(["rejected", "uncertain"].includes(status) && receipt.reason
        ? {
            reason: receipt.reason,
            error: reasonText(
              receipt.reason,
              status === "uncertain" && receipt.journal?.phase === "reserved"
                ? "rejected"
                : status,
              receipt.journal?.phase,
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
    // A command is accepted once the screen shows its prompt box cleared.
    let cleared = false;
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
        // Native prompt adapters close Claude menus or wait for Codex/OpenCode dialogs.
        await this.models.guardInput(id, tx.session, tx.raw, {
          nativeMenus: true,
        });
        await tx.write(text, {
          beforeImage: () => requireCurrentChatInput(this.requests, id),
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
            if (phase === "submit-intent")
              await this.expectAcceptance(id, file, tx.session.tool, receipt, text);
            receipt.status = "uncertain";
            receipt.journal = { phase, generation: tx.recoveryGeneration };
            this.write(file, receipt);
            mayHaveWritten = true;
          },
          onRefused: async (phase) => {
            if (phase === "submit-intent") this.withdrawAcceptance(id, file, receipt);
            receipt.journal = {
              phase: provenPhase[phase],
              generation: tx.recoveryGeneration,
            };
            this.write(file, receipt);
            if (phase === "paste-intent") mayHaveWritten = false;
          },
          onNotice: noticeRecorder(receipt),
        });
        if (receipt.command && tx.screen)
          cleared = await commandCleared(tx.session.tool, tx.screen);
      });
      receipt.status = "handed-off";
      if (cleared) confirm(receipt, {});
      // A message reached the terminal, so an earlier approval notice is history.
      this.requests.clearNotice?.(id);
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
        this.withdrawAcceptance(id, file, receipt);
        if (this.exists(file)) this.write(file, receipt);
        return "deferred";
      }
      if (!enterMaySent(receipt)) this.withdrawAcceptance(id, file, receipt);
      receipt.status = mayHaveWritten ? "uncertain" : "rejected";
      delete receipt.waiting;
      // Never keep the reason of an earlier hold for a different outcome.
      if (reason) receipt.reason = reason;
      else delete receipt.reason;
    }
    const dropped = this.settleAcceptance(file, receipt);
    if (this.exists(file)) this.write(file, receipt);
    if (dropped) this.block(id, file, dropped);
    return receipt.status;
  }

  /**
   * Right before Enter: record when it was due and, when the session has an
   * acceptance source, expect its native event. Images are matched by name.
   */
  async expectAcceptance(id, file, tool, receipt, text) {
    const since = Date.now();
    receipt.submittedAt = since;
    this.earlyAcceptance.delete(file);
    // Local commands send no native event: the screen confirms them instead.
    if (unconfirmedCommand(tool, text)) {
      receipt.command = true;
      receipt.confirmation = "screen";
      return;
    }
    delete receipt.command;
    if (!this.acceptance?.supports(id)) {
      receipt.confirmation = "text";
      return;
    }
    receipt.confirmation = "events";
    this.blockable.delete(file);
    this.blockable.set(file, text);
    if (this.blockable.size > MAX_BLOCKABLE)
      this.blockable.delete(this.blockable.keys().next().value);
    const imageNames = isNativeSlashCommand(tool, text)
      ? []
      : ((await claudeImageMessage(text))?.images.map((image) => path.basename(image)) ??
        []);
    this.acceptance.expect(id, { deliveryId: receipt.deliveryId, since, imageNames });
  }

  /**
   * A native acceptance event matched delivery `deliveryId`. Only a handed-off
   * or uncertain receipt changes; accepted is terminal. A delivery still running
   * takes the outcome when it finishes, so its own result never overwrites it.
   * A dropped prompt (blocked by a hook) is rejected asynchronously (block()).
   */
  accept(id, deliveryId, outcome) {
    if (!["accepted", "dropped"].includes(outcome.kind)) return;
    const file = this.file(id, deliveryId);
    if (this.active.has(file)) {
      this.earlyAcceptance.set(file, outcome);
      return;
    }
    if (outcome.kind === "dropped") {
      this.block(id, file, outcome);
      return;
    }
    this.blockable.delete(file);
    const receipt = this.read(file);
    if (receipt && confirm(receipt, outcome)) this.write(file, receipt);
  }

  /**
   * A hook blocked the delivery: clear the CLI prompt box when it holds exactly
   * our text, then reject the receipt. Never throws; the matcher calls it
   * synchronously, and a failing clear counts as a foreign draft.
   */
  async block(id, file, outcome) {
    try {
      const text = this.blockable.get(file);
      this.blockable.delete(file);
      const before = this.read(file);
      if (!confirmable.has(before?.status)) return;
      const prompt =
        text === undefined
          ? "foreign"
          : await clearBlockedPrompt({ sessions: this.sessions, id, text });
      // A retry may have started or settled the delivery meanwhile.
      const receipt = this.read(file);
      if (!confirmable.has(receipt?.status) || receipt.attemptId !== before.attemptId)
        return;
      rejectBlocked(receipt, outcome, prompt);
      this.write(file, receipt);
    } catch {
      console.error("AgentPier could not record a blocked chat delivery.");
    }
  }

  /** Enter was never sent: no later event may confirm this delivery. */
  withdrawAcceptance(id, file, receipt) {
    this.earlyAcceptance.delete(file);
    this.blockable.delete(file);
    this.acceptance?.withdraw(id, receipt.deliveryId);
  }

  /**
   * Apply an acceptance that arrived while this delivery ran. Returns a drop,
   * which the caller hands to block() once the receipt is written.
   */
  settleAcceptance(file, receipt) {
    const outcome = this.earlyAcceptance.get(file);
    this.earlyAcceptance.delete(file);
    if (outcome?.kind === "dropped") return outcome;
    if (outcome) {
      this.blockable.delete(file);
      confirm(receipt, outcome);
    }
    return null;
  }

  exists(file) {
    return fs.existsSync(file);
  }

  recover(id, deliveryId, body) {
    return recoverDelivery(this, id, deliveryId, body);
  }

  async discard(id) {
    fs.rmSync(this.folder(id), { recursive: true, force: true });
    this.changed(id);
  }
}
