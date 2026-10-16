import React, { useEffect, useRef } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantAttachmentsCopy as attachCopy } from "../../lib/i18n/messages/assistant-attachments.js";

// Attaching files, the one-message team permission and, on phones, the keyboard
// hint, behind the composer's "+" button (handoff 1d). Member chats offer only the
// attachment. Always mounted so aria-controls resolves.
export default function ComposerOptions({
  id,
  open,
  member = false,
  onAttach,
  teamAllowed,
  onTeamAllowed,
  hint,
  trigger,
  onClose,
}) {
  const root = useRef(null);
  useEffect(() => {
    if (open) root.current?.querySelector("button, input")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (root.current?.contains(event.target) || trigger.current?.contains(event.target))
        return;
      onClose(false);
    };
    // Safari on macOS does not focus a clicked switch or button, so focus falls to
    // the page and Escape never reaches this layer's own handler.
    const escape = (event) => {
      if (event.key !== "Escape" || document.activeElement !== document.body) return;
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onClose, trigger]);
  return (
    <div
      id={id}
      ref={root}
      className="assistant-options"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // The app closes the mobile drawer on Escape; this layer closes first.
        event.stopPropagation();
        onClose(true);
      }}
    >
      <button type="button" className="assistant-options-row" onClick={onAttach}>
        <Icon name="paperclip" />
        <span className="assistant-options-label">{attachCopy.attach}</span>
      </button>
      {!member && (
        <label className="assistant-options-row">
          <Icon name="users" />
          <span className="assistant-options-label">{copy.team.allowOnce}</span>
          <input
            type="checkbox"
            role="switch"
            checked={teamAllowed}
            aria-checked={teamAllowed}
            onChange={(event) => onTeamAllowed(event.target.checked)}
          />
          <span className="assistant-switch" aria-hidden="true" />
        </label>
      )}
      {hint && <p className="assistant-options-hint">{hint}</p>}
    </div>
  );
}
