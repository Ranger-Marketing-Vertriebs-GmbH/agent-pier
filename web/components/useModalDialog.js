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
 * lands on the close button: it goes to a `[data-autofocus]` element, else the first
 * visible text entry field, else the dialog itself (which has no visible focus ring).
 */
export default function useModalDialog() {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    // An `autofocus` dialog focuses itself in showModal(), so no control flashes a ring.
    dialog.setAttribute("autofocus", "");
    dialog.showModal();
    const target =
      [...dialog.querySelectorAll("[data-autofocus]")].find(
        (element) => !element.disabled && visible(element),
      ) || [...dialog.querySelectorAll(fields)].find(visible);
    (target || dialog).focus({ preventScroll: !target });
    return () => dialog.close();
  }, []);
  return ref;
}
