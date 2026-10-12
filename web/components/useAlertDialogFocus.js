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
      const items = [...ref.current.querySelectorAll(focusable)];
      if (!items.length) return event.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !ref.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !ref.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  return { ref, onKeyDown };
}
