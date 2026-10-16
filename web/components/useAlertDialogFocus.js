import { useEffect, useRef } from "react";

const focusable = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Focus management for an inline `role="alertdialog"`: focus moves to its
 * `[data-autofocus]` element (else the first focusable one) on open, Tab and
 * Shift+Tab cycle inside it, Escape calls `onCancel` (unless the cancel button is
 * disabled) without closing a surrounding dialog, and focus returns to the opener on
 * close. An opener that was replaced meanwhile is found again by its
 * `data-focus-key` (or the given `returnKey`).
 */
export function useAlertDialogFocus(onCancel, returnKey) {
  const ref = useRef(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const keyRef = useRef(returnKey);
  // Read while rendering: the commit may already replace the opener, which drops focus.
  const trigger = useRef(typeof document === "undefined" ? null : document.activeElement);
  const frame = useRef(0);
  useEffect(() => {
    const dialog = ref.current;
    const opener = trigger.current;
    const key = keyRef.current || opener?.getAttribute?.("data-focus-key");
    // A remount (StrictMode) must not let the previous cleanup steal focus back.
    cancelAnimationFrame(frame.current);
    (
      dialog.querySelector("[data-autofocus]") || dialog.querySelector(focusable)
    )?.focus();
    return () => {
      frame.current = requestAnimationFrame(() => {
        // Only reclaim focus the closing dialog left behind; never pull it from elsewhere.
        const active = document.activeElement;
        if (active && active !== document.body && !dialog.contains(active)) return;
        const target =
          opener?.isConnected && opener !== document.body
            ? opener
            : key && document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
        target?.focus?.();
      });
    };
  }, []);
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!ref.current.querySelector("[data-autofocus]")?.disabled) cancel.current();
    } else if (event.key === "Tab") {
      // Every step is taken here: Safari on macOS lets Tab skip buttons by default, so
      // its own next stop would lie outside the dialog.
      event.preventDefault();
      const items = [...ref.current.querySelectorAll(focusable)].filter(
        (item) =>
          item.getAttribute("tabindex") !== "-1" && item.getClientRects().length > 0,
      );
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      const next = event.shiftKey
        ? at <= 0
          ? items.length - 1
          : at - 1
        : at === -1 || at === items.length - 1
          ? 0
          : at + 1;
      items[next].focus();
    }
  };
  return { ref, onKeyDown };
}
