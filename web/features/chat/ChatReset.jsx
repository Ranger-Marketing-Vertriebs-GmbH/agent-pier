import "./chat-reset.css";
import React from "react";
import { chatViewCopy as copy } from "../../lib/i18n/messages/chat.js";

export default function ChatReset({ status, children }) {
  if (!status) return children;
  return (
    <>
      <div className="chat-reset-notice" role="status">
        <strong>
          {status === "requested" ? copy.resetRequested : copy.resetConfirmed}
        </strong>
        {status === "requested" && <p>{copy.resetPendingHint}</p>}
      </div>
      {status === "requested" ? (
        <details className="chat-reset-history">
          <summary>{copy.resetPrevious}</summary>
          {children}
        </details>
      ) : (
        children
      )}
    </>
  );
}
