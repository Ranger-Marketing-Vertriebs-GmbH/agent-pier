import { useEffect, useState } from "react";

// How much shorter the visual viewport must be than the layout viewport before it
// counts as covered by a keyboard rather than by browser chrome.
const coveredHeight = 150;

/**
 * Whether an on-screen keyboard covers the page on a touch device: the field with
 * `fieldId` has focus (iOS opens its keyboard on focus but shrinks the visual
 * viewport only after the animation), or the visual viewport is notably shorter
 * than the layout viewport at normal zoom. False on devices without a coarse pointer.
 */
export default function useOnScreenKeyboard(fieldId) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    const touch = window.matchMedia("(any-pointer: coarse)");
    let frame = 0;
    const update = () => {
      frame = 0;
      const focused = document.activeElement?.id === fieldId;
      const covered =
        !!viewport &&
        viewport.scale <= 1.01 &&
        window.innerHeight - viewport.height > coveredHeight;
      setOpen(touch.matches && (focused || covered));
    };
    // During focusout the old element may still be active: read once focus settled.
    const later = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    viewport?.addEventListener("resize", later);
    touch.addEventListener("change", later);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      viewport?.removeEventListener("resize", later);
      touch.removeEventListener("change", later);
    };
  }, [fieldId]);
  return open;
}
