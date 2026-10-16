import { useCallback, useEffect, useRef, useState } from "react";
import {
  holdUnloadWarning,
  needsDecision,
  registerNavigationGuard,
} from "../../../lib/navigation-guard.js";

/**
 * Asks before a navigation drops an unsaved wizard (close, back to the list, another
 * page, a reload). Moves between the wizard's own steps never ask (`stays`).
 * Returns the sheet's state; `onDiscard` lets the navigation go on.
 */
export default function useWizardGuard({ dirty, stays }) {
  const [pending, setPending] = useState(null);
  const live = useRef(null);
  live.current = { dirty, stays };
  const waiting = useRef(null);
  waiting.current = pending;
  useEffect(() => {
    // An unmounted wizard refuses the navigation it was still asking about.
    let asking = null;
    const unregister = registerNavigationGuard((request) =>
      needsDecision(request, live.current)
        ? new Promise((resolve) => {
            asking = resolve;
            setPending({ resolve });
          })
        : true,
    );
    return () => {
      unregister();
      asking?.(false);
    };
  }, []);
  useEffect(() => (dirty ? holdUnloadWarning() : undefined), [dirty]);
  const finish = useCallback((accepted) => {
    const decision = waiting.current;
    waiting.current = null;
    setPending(null);
    decision?.resolve(accepted);
  }, []);
  return {
    open: Boolean(pending),
    onDiscard: () => finish(true),
    onCancel: () => finish(false),
  };
}
