import { createHash } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/de/chat-delivery.js";
import {
  requireChatInput,
  requireCurrentChatInput,
} from "../../application/request-input-guard.js";

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
    if (blocked) reason = copy.rejected;
    else if (current !== expectedAttemptId.toLowerCase()) reason = copy.recoveryChanged;
    else if (
      !receipt.journal?.generation ||
      receipt.journal.generation !== tx.recoveryGeneration
    )
      reason = copy.recoveryRuntime;
    else if (!["reserved", "pasted"].includes(receipt.journal.phase))
      reason = copy.recoveryUncertain;
    else if (
      receipt.journal.phase === "pasted" &&
      (tx.composer.state !== "text" || tx.composer.text !== text.replace(/\r\n?/g, "\n"))
    )
      reason = copy.recoveryComposer;
    const finish = (action, explanation) => {
      receipt.recovery = { action, reason: explanation, requestId };
      const result = { ...delivery.result(receipt, file), recovery: receipt.recovery };
      receipt.recoveries ||= {};
      receipt.recoveries[requestId] = { requestHash, result };
      delivery.write(file, receipt);
      return result;
    };
    if (reason) return finish("blocked", reason);
    if (mode === "check")
      return finish(
        "none",
        receipt.journal.phase === "pasted"
          ? copy.recoveryReadySubmit
          : copy.recoveryReadyResend,
      );
    try {
      requireCurrentChatInput(delivery.requests, id);
      await delivery.models.guardInput(id, tx.session, tx.raw);
    } catch {
      return finish("blocked", copy.rejected);
    }
    const submitOnly = receipt.journal.phase === "pasted";
    receipt.recoveries ||= {};
    receipt.recoveries[requestId] = { requestHash };
    receipt.attemptId = requestId;
    receipt.status = "uncertain";
    // Keep the last proven phase until the writer persists its next intent.
    delivery.write(file, receipt);
    delivery.active.add(file);
    try {
      await tx.write(text.replace(/\r\n?/g, "\n"), {
        submitOnly,
        allowComposerDraft: !submitOnly,
        onPhase: async (phase) => {
          if (["paste-intent", "submit-intent"].includes(phase))
            requireCurrentChatInput(delivery.requests, id);
          receipt.journal = { phase, generation: tx.recoveryGeneration };
          delivery.write(file, receipt);
        },
      });
      receipt.status = "handed-off";
    } catch {
      receipt.status = "uncertain";
    } finally {
      delivery.active.delete(file);
    }
    return finish(
      receipt.status === "handed-off"
        ? submitOnly
          ? "submitted-existing"
          : "resent"
        : "blocked",
      receipt.status === "handed-off" ? copy.recoveryHandedOff : copy.recoveryUncertain,
    );
  });
}
