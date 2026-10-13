import React, { useCallback, useId, useState } from "react";
import { commonCopy } from "../lib/i18n/messages/common.js";

// ⓘ hints are disclosures, never tooltips: the button reveals the hint text verbatim
// below its row or group label.
export function useInfoHint() {
  const id = `${useId()}-hint`;
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return { id, open, toggle };
}

export function InfoHintButton({ hint, label }) {
  return (
    <button
      type="button"
      className="info-hint-button"
      aria-expanded={hint.open}
      aria-controls={hint.id}
      aria-label={label ?? commonCopy.showHint}
      onClick={hint.toggle}
    >
      i
    </button>
  );
}

export function InfoHintText({ hint, children }) {
  return (
    <p id={hint.id} className="info-hint-text" hidden={!hint.open}>
      {children}
    </p>
  );
}
