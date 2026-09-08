import React from "react";
import Message from "./ChatMessage.jsx";
import { visibleDeliveries } from "./chat-draft.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/messages/chat.js";

export default function ChatDeliveryStatus({ delivery, messages, session, blocked }) {
  const items = [...delivery.recent, ...(delivery.outbox ? [delivery.outbox] : [])];
  const visible = new Set(visibleDeliveries(items, messages).map((item) => item.id));
  return items
    .filter((item) => visible.has(item.id) || item.id === delivery.outbox?.id)
    .map((item) => {
      const pending = item.id === delivery.outbox?.id;
      const status = pending && delivery.sending ? "sending" : item.status;
      return (
        <div className="chat-delivery-message" key={item.id}>
          {visible.has(item.id) && (
            <Message
              message={{ id: item.id, role: "user", text: item.displayText || item.text }}
              tool={session.tool}
              sessionId={session.id}
            />
          )}
          <div className="chat-delivery-status" role="status" aria-label={copy.ariaLabel}>
            <span>{copy[status] || copy.checking}</span>
            {item.error && <span role="alert">{item.error}</span>}
          </div>
          {pending && !delivery.sending && (
            <div className="chat-delivery-actions">
              {item.status === "uncertain" && <p>{copy.uncertainHint}</p>}
              {item.status === "absent" && (
                <button
                  type="button"
                  className="button"
                  disabled={blocked}
                  onClick={() => delivery.send(messages)}
                >
                  {copy.retry}
                </button>
              )}
              {["waiting", "checking", "pending", "uncertain"].includes(item.status) && (
                <button type="button" className="button" onClick={delivery.check}>
                  {copy.check}
                </button>
              )}
              {["uncertain", "rejected"].includes(item.status) && (
                <button
                  type="button"
                  className="button"
                  onClick={() => delivery.draft.restore(item.id)}
                >
                  {item.status === "uncertain" ? copy.restore : copy.edit}
                </button>
              )}
            </div>
          )}
          {!pending && (
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
}
