import React from "react";
import { chatDeliveryCopy as copy } from "../../lib/i18n/messages/chat.js";

export default function NativeDeliveryBadge({ state, tool }) {
  return (
    <div
      className={`chat-native-delivery ${state}`}
      role="status"
      aria-label={copy.ariaLabel}
    >
      <span aria-hidden="true">{state === "nativeQueued" ? "◷" : "✓"}</span>
      <span>
        {copy[state]}
        {state === "nativeQueued" && (
          <small>
            {tool === "codex" ? copy.nativeCodexQueueHint : copy.nativeQueueHint}
          </small>
        )}
      </span>
    </div>
  );
}
