import { nativeInputQueue } from "./native-input-queue.js";
import { createHash } from "node:crypto";
import {
  claudeChipsOnly,
  claudeImageDraft,
  claudeImageMessage,
  missingClaudeImages,
} from "../sessions/claude-image-paste.js";
import { problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";
import {
  requireChatInput,
  requireCurrentChatInput,
} from "../../application/request-input-guard.js";

/** Journal intents written before bytes that their guard may still refuse. */
export const intents = new Set(["paste-intent", "text-intent", "submit-intent"]);
/** The last proven phase when an intent's guard refused before writing. */
export const provenPhase = {
  "paste-intent": "reserved",
  "text-intent": "images-pasted",
  "submit-intent": "pasted",
};
/**
 * What a held message still needs by its proven phase: all of it, only the text
 * after its image chips, or only Enter.
 */
export const heldMode = { reserved: "send", "images-pasted": "text", pasted: "submit" };

/**
 * How a retry may continue from the journal, proven by the current composer:
 * resend a message never written, add the text after its own image chips, or
 * only submit the complete draft. Claude image paths appear as chips, so image
 * drafts match with chips in their place. Journals of earlier versions carry
 * only reserved/paste-intent/pasted/submit-intent/submitted; their single-paste
 * Claude drafts have the same chips-first form. Returns a plan or a reason.
 */
async function recoveryPlan(tool, phase, { composer, raw, pane }, text) {
  if (phase === "reserved") return { plan: "resend" };
  if (!["pasted", "images-pasted", "text-intent"].includes(phase))
    return { reason: copy.recoveryUncertain };
  const message = tool === "claude" ? await claudeImageMessage(text) : null;
  const full = message
    ? claudeImageDraft(composer, message, { text: message.text })
    : composer.state === "text" && composer.text === text;
  let result;
  if (phase === "pasted")
    result = full ? { plan: "submit" } : { reason: copy.recoveryComposer };
  // The text paste may or may not have happened: only its visible result counts.
  else if (phase === "text-intent")
    result = full ? { plan: "submit" } : { reason: copy.recoveryUncertain };
  else
    result =
      claudeImageDraft(composer, message) ||
      (message && claudeChipsOnly(raw, pane, message.images.length))
        ? { plan: "text" }
        : { reason: copy.recoveryComposer };
  // A deleted attachment can no longer be compared with its chip.
  if (result.reason && tool === "claude" && (await missingClaudeImages(text)))
    return { reason: copy.recoveryAttachmentMissing };
  return result;
}

/** Stable, translatable identifier of a refused or unconfirmed terminal handoff. */
export const deliveryReason = (error) =>
  typeof error?.code === "string" && Object.hasOwn(copy.reasons, error.code)
    ? error.code
    : undefined;

/**
 * What a message keeps waiting for instead of being refused: an AgentPier
 * request (question, permission, startup dialog) or a native Claude question or
 * menu in the terminal. Its journal still proves whether the text was pasted.
 */
export const waitingFor = (code) =>
  code === "CHAT_REQUEST_PENDING"
    ? "request"
    : ["CHAT_QUESTION_OPEN", "CHAT_DIALOG_NOT_CLOSED"].includes(code)
      ? "dialog"
      : null;

/** Informational, non-blocking notes on how a message reached the TUI. */
export const noticeRecorder = (receipt) => async (code) => {
  if (!Object.hasOwn(copy.notices, code)) return;
  receipt.notices = [...new Set([...(receipt.notices || []), code])];
};

/** Pasted-but-not-submitted wording for uncertain outcomes, else the plain reason. */
export const reasonText = (code, status) =>
  (status === "uncertain" && copy.pastedReasons[code]) || copy.reasons[code];

export async function recoverDelivery(delivery, id, deliveryId, body) {
  const { attemptId, expectedAttemptId, deliveryScope, text, mode } = body;
  const file = delivery.file(id, deliveryId);
  delivery.file(id, attemptId);
  delivery.file(id, expectedAttemptId);
  if (
    !["check", "retry"].includes(mode) ||
    typeof text !== "string" ||
    text.length > 32000
  )
    throw problem(copy.invalid);
  const hash = createHash("sha256")
    .update(JSON.stringify([text, true]))
    .digest("hex");
  const requestHash = createHash("sha256")
    .update(JSON.stringify([expectedAttemptId.toLowerCase(), deliveryScope, hash, mode]))
    .digest("hex");
  const requestId = attemptId.toLowerCase();
  const replay = (receipt) => {
    if (!receipt || receipt.scope !== deliveryScope || receipt.hash !== hash)
      throw problem(copy.conflict, 409);
    const previous = receipt.recoveries?.[requestId];
    if (!previous) return null;
    if (previous.requestHash !== requestHash) throw problem(copy.conflict, 409);
    return (
      previous.result || {
        ...delivery.result(receipt, file),
        recovery: { action: "blocked", reason: copy.recoveryUncertain, requestId },
      }
    );
  };
  delivery.checkScope(await delivery.sessions.get(id), deliveryScope);
  const cached = replay(delivery.read(file));
  if (cached) return cached;
  let blocked = false;
  try {
    await requireChatInput(delivery.requests, id);
  } catch {
    blocked = true;
  }
  return delivery.sessions.withChatInput(id, async (tx) => {
    delivery.checkScope(tx.session, deliveryScope);
    const receipt = delivery.read(file);
    const previous = replay(receipt);
    if (previous) return previous;
    if (requestId === receipt.deliveryId) throw problem(copy.conflict, 409);
    if (Object.keys(receipt.recoveries || {}).length >= 128)
      throw problem(copy.recoveryLimit, 409);
    if (delivery.active.has(file))
      return {
        ...delivery.result(receipt, file),
        recovery: { action: "blocked", reason: copy.recoveryPending, requestId },
      };
    const current = receipt.attemptId || receipt.deliveryId;
    let reason;
    if (current !== expectedAttemptId.toLowerCase()) reason = copy.recoveryChanged;
    else if (
      receipt.journal?.phase !== "reserved" &&
      (!receipt.journal?.generation ||
        receipt.journal.generation !== tx.recoveryGeneration)
    )
      reason = copy.recoveryRuntime;
    const normalized = text.replace(/\r\n?/g, "\n");
    let plan;
    if (!reason) {
      const result = await recoveryPlan(
        tx.session.tool,
        receipt.journal?.phase,
        tx,
        normalized,
      );
      plan = result.plan;
      reason = result.reason;
    }
    const modeOf = { resend: "send", text: "text", submit: "submit" };
    const finish = (action, explanation, code) => {
      receipt.recovery = {
        action,
        reason: code ? reasonText(code, receipt.status) : explanation,
        requestId,
        ...(code ? { code } : {}),
      };
      const result = { ...delivery.result(receipt, file), recovery: receipt.recovery };
      receipt.recoveries ||= {};
      receipt.recoveries[requestId] = { requestHash, result };
      delivery.write(file, receipt);
      return result;
    };
    // An open request, question or menu holds the redelivery like a fresh send.
    const hold = (waiting, code, proof) => {
      receipt.attemptId = requestId;
      receipt.waiting = waiting;
      receipt.reason = code;
      delivery.active.add(file);
      delivery.held.hold({
        id,
        file,
        receipt,
        text: normalized,
        hash: receipt.hash,
        scope: deliveryScope,
        mode: heldMode[receipt.journal.phase] ?? modeOf[plan],
        proof,
      });
      return finish("held", copy.recoveryHeld);
    };
    if (reason) return finish("blocked", reason);
    // Never overtake held messages: their pasted text could be cleared or
    // submitted out of order. Redelivery waits in the same queue.
    if (mode === "retry" && delivery.held.busy(id)) return hold("queue", "CHAT_QUEUED");
    if (blocked)
      return mode === "check"
        ? finish("blocked", copy.rejected)
        : hold("request", "CHAT_REQUEST_PENDING");
    if (mode === "check")
      return finish(
        "none",
        {
          resend: copy.recoveryReadyResend,
          text: copy.recoveryReadyText,
          submit: copy.recoveryReadySubmit,
        }[plan],
      );
    try {
      requireCurrentChatInput(delivery.requests, id);
      await delivery.models.guardInput(id, tx.session, tx.raw, {
        nativeMenus: tx.session.tool === "claude",
      });
    } catch (error) {
      if (error.code === "CHAT_REQUEST_PENDING")
        return hold("request", "CHAT_REQUEST_PENDING");
      return finish("blocked", copy.rejected);
    }
    const submitOnly = plan === "submit";
    receipt.recoveries ||= {};
    receipt.recoveries[requestId] = { requestHash };
    receipt.attemptId = requestId;
    receipt.observation = {
      generation: tx.observationGeneration,
      startedAt: Date.now(),
      providerSessionId: tx.providerSessionId || null,
      hash: receipt.hash,
      baseline: nativeInputQueue(tx.session.tool, tx.raw, tx.pane),
    };
    receipt.status = "uncertain";
    delete receipt.reason;
    delete receipt.notices;
    // Keep the last proven phase until the writer persists its next intent.
    delivery.write(file, receipt);
    delivery.active.add(file);
    let code;
    let proof;
    try {
      await tx.write(normalized, {
        onProof: (value) => (proof = value),
        submitOnly,
        ...(plan === "text" ? { resume: "text" } : {}),
        allowComposerDraft: plan === "resend",
        onPhase: async (phase) => {
          if (intents.has(phase)) requireCurrentChatInput(delivery.requests, id);
          receipt.journal = { phase, generation: tx.recoveryGeneration };
          delivery.write(file, receipt);
        },
        onRefused: async (phase) => {
          receipt.journal = {
            phase: provenPhase[phase],
            generation: tx.recoveryGeneration,
          };
          delivery.write(file, receipt);
        },
        onNotice: noticeRecorder(receipt),
      });
      receipt.status = "handed-off";
    } catch (error) {
      code = deliveryReason(error);
      receipt.status = receipt.journal.phase === "reserved" ? "rejected" : "uncertain";
      if (code) receipt.reason = code;
    } finally {
      delivery.active.delete(file);
    }
    if (
      receipt.status !== "handed-off" &&
      waitingFor(code) &&
      heldMode[receipt.journal.phase]
    ) {
      if (receipt.journal.phase === "reserved") receipt.status = "pending";
      return hold(waitingFor(code), code, proof);
    }
    return finish(
      receipt.status === "handed-off"
        ? { resend: "resent", text: "completed-existing", submit: "submitted-existing" }[
            plan
          ]
        : "blocked",
      receipt.status === "handed-off"
        ? copy.recoveryHandedOff
        : receipt.status === "rejected"
          ? copy.rejected
          : copy.recoveryUncertain,
      code,
    );
  });
}
