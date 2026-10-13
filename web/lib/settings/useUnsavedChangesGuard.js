import { useCallback, useEffect, useRef, useState } from "react";
import {
  holdUnloadWarning,
  needsDecision,
  registerNavigationGuard,
} from "../navigation-guard.js";

/**
 * Asks before any navigation leaves a dirty draft (tab switch, back, agent or profile
 * switch, app navigation) and warns before unload. Returns UnsavedChangesSheet props.
 */
export default function useUnsavedChangesGuard({ draft, tab, save, stays }) {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const live = useRef(null);
  live.current = { dirty: draft.dirty, reset: draft.reset, save, stays };
  const waiting = useRef(null);
  waiting.current = pending;
  useEffect(() => {
    // An unmounted draft refuses the navigation it was still asking about.
    let asking = null;
    const unregister = registerNavigationGuard((request) =>
      needsDecision(request, { dirty: live.current.dirty, stays: live.current.stays })
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
  useEffect(() => (draft.dirty ? holdUnloadWarning() : undefined), [draft.dirty]);
  const finish = useCallback((accepted) => {
    const decision = waiting.current;
    waiting.current = null;
    setPending(null);
    decision?.resolve(accepted);
  }, []);
  const onSave = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      // A save already running from the bar is awaited, not refused.
      finish((await live.current.save())?.status === "saved");
    } catch {
      finish(false);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }, [finish]);
  const onDiscard = useCallback(() => {
    live.current.reset();
    finish(true);
  }, [finish]);
  // Escape while "Save and switch" runs must not settle the navigation early.
  const onCancel = useCallback(() => {
    if (!saving.current) finish(false);
  }, [finish]);
  return {
    open: Boolean(pending) && !draft.confirmation,
    tab,
    count: draft.changeCount,
    busy,
    onSave,
    onDiscard,
    onCancel,
  };
}
