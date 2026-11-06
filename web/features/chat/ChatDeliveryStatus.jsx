import "./chat-delivery.css";
import NativeDeliveryBadge from "./NativeDeliveryBadge.jsx";
import React from "react";
import Message from "./ChatMessage.jsx";
import { deliveryNotices, visibleDeliveries } from "./chat-draft.js";
import { deliveryView } from "./delivery-confirmation.js";
import useDeliveryClock from "./useDeliveryClock.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/messages/chat.js";
import { serverText } from "../../lib/server-messages.js";

export default function ChatDeliveryStatus({
  delivery,
  messages,
  session,
  blocked,
  openFile,
  openTerminal,
  position = "current",
}) {
  const items = [...delivery.recent, ...(delivery.outbox ? [delivery.outbox] : [])];
  const visible = new Set(visibleDeliveries(items, messages).map((item) => item.id));
  const notices = deliveryNotices(delivery, messages, position);
  const now = useDeliveryClock(notices);
  const content = notices.map((item) => {
    // Server confirmation (events or screen); null keeps the text-based presentation.
    const view = deliveryView(item, now);
    const hook = view === "hookBlocked" || view === "hookBlockedDraft";
    // Accepted: no actions; a command shows only its brief notice.
    const quiet = view === "accepted" || view === "commandHandedOff";
    // Before the ask, an event-confirmed handoff only waits for the CLI.
    const inspectable =
      ["uncertain", "handed-off"].includes(item.status) && view !== "handed-off";
    // Its text left the composer: rejected, or unconfirmed after the ask.
    const editable =
      item.id !== delivery.outbox?.id &&
      (item.status === "rejected" || view === "askCheck") &&
      item.released;
    const native = delivery.nativeStates?.get(item.id);
    const pending = item.id === delivery.outbox?.id;
    const recovering = item.id === delivery.recovering;
    // Held by the server behind a question, request, menu or earlier message.
    const held = item.status === "pending" && Boolean(item.waiting);
    // Stable server reason codes are translated here; free text is a fallback.
    // An uncertain outcome before Enter means the text sits in Claude's prompt.
    // With only the image chips in the prompt ("images"), the wording says so.
    const reasonText = (code) =>
      (item.status === "uncertain" &&
        item.pasted === "images" &&
        copy.pastedReasons[code] &&
        (copy.imagesPastedReasons[code] || copy.imagesPasted)) ||
      (item.status === "uncertain" &&
        item.pasted !== false &&
        copy.pastedReasons[code]) ||
      copy.reasons[code];
    const detail = hook
      ? item.hookReason
      : reasonText(item.reason) || serverText(item.error);
    const recoveryDetail =
      reasonText(item.recovery?.code) || serverText(item.recovery?.reason);
    const status = recovering
      ? "recovering"
      : pending && delivery.sending
        ? "sending"
        : item.status;
    return (
      <div className="chat-delivery-message" key={item.id}>
        {visible.has(item.id) && (
          <Message
            message={{ id: item.id, role: "user", text: item.displayText || item.text }}
            tool={session.tool}
            sessionId={session.id}
            cwd={session.cwd}
            openFile={openFile}
          />
        )}
        {native ? (
          <NativeDeliveryBadge state={native.state} tool={session.tool} />
        ) : view === "accepted" ? null : (
          <div className="chat-delivery-status" role="status" aria-label={copy.ariaLabel}>
            <span>
              {view && view !== "handed-off" && !recovering
                ? copy[view]
                : status === "pending" && item.waiting === "request"
                  ? copy.waitingRequest
                  : status === "pending" && item.waiting === "dialog"
                    ? copy.waitingDialog
                    : status === "pending" && item.waiting === "queue"
                      ? copy.waitingQueue
                      : status === "pending" && item.waiting === "starting"
                        ? copy.waitingStarting
                        : copy[status] || copy.checking}
            </span>
            {detail && <span role="alert">{detail}</span>}
            {item.recovery?.action === "blocked" && (
              <span role="alert">{recoveryDetail}</span>
            )}
          </div>
        )}
        {(item.notices || [])
          .filter((code) => copy.notices[code])
          .map((code) => (
            // Informational only: the message was handed off regardless.
            <p className="chat-delivery-note" key={code}>
              {copy.notices[code]}
            </p>
          ))}
        {!native && !delivery.sending && !quiet && (
          <div className="chat-delivery-actions">
            {item.status === "uncertain" && <p>{copy.uncertainHint}</p>}
            {pending && item.status === "absent" && <p>{copy.absentHint}</p>}
            {pending && item.status === "absent" && (
              <button
                type="button"
                className="button"
                disabled={blocked}
                onClick={() => delivery.send(messages)}
              >
                {copy.retry}
              </button>
            )}
            {pending && ["waiting", "checking", "pending"].includes(item.status) && (
              <button type="button" className="button" onClick={delivery.check}>
                {copy.check}
              </button>
            )}
            {/* A rejected message is back in the composer: send it from there. */}
            {inspectable && (
              <button
                type="button"
                className="button"
                disabled={blocked || Boolean(delivery.recovering)}
                onClick={() =>
                  delivery.recover(
                    item.id,
                    item.status === "handed-off" ? "check" : "retry",
                  )
                }
              >
                {item.status === "handed-off" ? copy.inspect : copy.redeliver}
              </button>
            )}
            {held && !item.pasted && (
              <button
                type="button"
                className="button"
                onClick={() => delivery.cancel(item.id)}
              >
                {copy.cancel}
              </button>
            )}
            {/* Its text left the CLI prompt: send it again as it was. */}
            {!pending && view === "hookBlocked" && item.released && (
              <button
                type="button"
                className="button"
                disabled={
                  blocked ||
                  delivery.locked ||
                  Boolean(delivery.text.trim()) ||
                  delivery.attachments.length > 0
                }
                onClick={() => delivery.resend(item.id, messages)}
              >
                {copy.redeliver}
              </button>
            )}
            {editable && (
              <button
                type="button"
                className="button"
                onClick={() => delivery.draft.reuse(item.id)}
              >
                {copy.edit}
              </button>
            )}
            {(item.recovery?.action === "blocked" ||
              view === "hookBlockedDraft" ||
              (held && (item.waiting === "dialog" || item.pasted))) && (
              <button type="button" className="button" onClick={openTerminal}>
                {copy.openTerminal}
              </button>
            )}
            {pending && ["uncertain", "rejected", "absent"].includes(item.status) && (
              <button
                type="button"
                className="button"
                disabled={Boolean(delivery.recovering)}
                onClick={() => delivery.draft.restore(item.id)}
              >
                {item.status === "uncertain" ? copy.restore : copy.edit}
              </button>
            )}
          </div>
        )}
        {!native &&
          !pending &&
          ["handed-off", "absent", "rejected"].includes(item.status) &&
          !recovering && (
            <button
              type="button"
              className="chat-delivery-dismiss"
              onClick={() => delivery.draft.dismiss(item.id)}
            >
              {copy.dismiss}
            </button>
          )}
      </div>
    );
  });
  if (position !== "earlier") return content;
  if (!notices.length) return null;
  return (
    <details className="chat-delivery-saved">
      <summary>{copy.savedNotices(notices.length)}</summary>
      <p>{copy.savedNoticesHint}</p>
      {content}
    </details>
  );
}
