import { useEffect, useRef } from "react";

// Text entry fields only: a select, checkbox or radio would open with a focus ring.
const fields = [
  "input:not([type=checkbox], [type=radio], [type=hidden], [type=button], [type=submit], [type=file])",
  "textarea",
]
  .map((selector) => `${selector}:not(:disabled)`)
  .join(", ");

function visible(element) {
  return element.getClientRects().length > 0;
}

/**
 * Opens a `<dialog>` modally on mount and closes it on unmount. Initial focus never
 * lands on the close button: with a fine pointer it goes to a `[data-autofocus]`
 * element, else the first visible text entry field; on touch screens, or without
 * either, it stays on the dialog itself (which has no visible focus ring).
 */
export default function useModalDialog() {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    // An `autofocus` dialog focuses itself in showModal(), so no control flashes a ring.
    dialog.setAttribute("autofocus", "");
    dialog.showModal();
    // On touch screens a focused field opens the on-screen keyboard, so the dialog
    // itself takes focus there and fields wait for a tap.
    const touch = window.matchMedia?.("(pointer: coarse), (hover: none)").matches;
    const target = touch
      ? null
      : [...dialog.querySelectorAll("[data-autofocus]")].find(
          (element) => !element.disabled && visible(element),
        ) || [...dialog.querySelectorAll(fields)].find(visible);
    (target || dialog).focus({ preventScroll: !target });
    return () => dialog.close();
  }, []);
  return ref;
}
