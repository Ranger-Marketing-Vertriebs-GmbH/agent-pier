import React from "react";
import Icon from "./Icon.jsx";
import useCopy from "./useCopy.js";
import { copyButtonCopy } from "../lib/i18n/messages/components.js";

/**
 * Copies `text` and reports the result in a live region next to the button. The
 * label names what it copies ("Copy command: Add"). `iconOnly` shows a copy icon
 * with the label as its accessible name; `onFailed` lets the caller reveal or select
 * the text so it can be copied by hand.
 */
export default function CopyButton({
  text,
  label,
  copiedLabel = copyButtonCopy.copied,
  failedLabel = copyButtonCopy.failed,
  className = "button secondary",
  iconOnly = false,
  onFailed,
}) {
  const { status, copy } = useCopy();
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        data-copied={status === "copied" || undefined}
        onClick={async () => {
          if (!(await copy(text))) onFailed?.();
        }}
      >
        {iconOnly ? (
          <Icon name={status === "copied" ? "check" : "copy"} size={16} />
        ) : (
          label
        )}
      </button>
      {status && (
        <span role="status" className="copy-status">
          {status === "copied" ? copiedLabel : failedLabel}
        </span>
      )}
    </>
  );
}
