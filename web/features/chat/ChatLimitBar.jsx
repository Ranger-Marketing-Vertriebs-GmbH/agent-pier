import React from "react";
import { chatViewCopy as copy } from "../../lib/i18n/messages/chat.js";

// A session stopped at a usage limit: the CLI's own text, and the two ways on.
export default function ChatLimitBar({
  detail,
  disabled,
  continueDisabled = false,
  onChangeModel,
  onContinue,
}) {
  return (
    <div
      className="chat-limit-warnings chat-limit-bar"
      role="status"
      aria-label={copy.limitBarTitle}
    >
      <strong>{copy.limitBarTitle}</strong>
      {detail && <p>{detail}</p>}
      <div className="chat-limit-actions">
        <button
          type="button"
          className="button secondary compact"
          disabled={disabled}
          onClick={onChangeModel}
        >
          {copy.limitChangeModel}
        </button>
        <button
          type="button"
          className="button primary compact"
          disabled={disabled || continueDisabled}
          onClick={onContinue}
        >
          {copy.limitContinue}
        </button>
      </div>
    </div>
  );
}
