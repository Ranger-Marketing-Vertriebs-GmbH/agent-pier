import React, { useEffect, useRef } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";

// The one-message team permission and, on phones, the keyboard hint, behind the
// composer's "+" button (handoff 1d). Always mounted so aria-controls resolves.
export default function ComposerOptions({
  id,
  open,
  teamAllowed,
  onTeamAllowed,
  hint,
  trigger,
  onClose,
}) {
  const root = useRef(null);
  useEffect(() => {
    if (open) root.current?.querySelector("input")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (root.current?.contains(event.target) || trigger.current?.contains(event.target))
        return;
      onClose(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
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
      {hint && <p className="assistant-options-hint">{hint}</p>}
    </div>
  );
}
