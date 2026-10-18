import React, { useCallback, useEffect, useRef, useState } from "react";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  holdUnloadWarning,
  needsDecision,
  registerNavigationGuard,
} from "../../lib/navigation-guard.js";

// A draft stays on screen while the route keeps its pipelines tab and item.
const keepsDraft = (next, route) =>
  next?.view === "pipelines" &&
  (next.pipelineTab || "runs") === (route.pipelineTab || "runs") &&
  (next.pipelineItem || "") === (route.pipelineItem || "");

/**
 * Protects an editor's unsaved draft on a pipelines page with the one
 * UnsavedChangesSheet: Save and continue, Discard, Cancel. It asks before page
 * actions (`guarded(go, discarded)` runs `go` at once while the draft is clean;
 * `discarded` runs only after a dirty draft was discarded) and, through the global
 * navigation guard, before the sidebar, back, tab switches and reload leave it.
 * The editor reports `setDirty(dirty)` and registers its save with `setSave(fn)`,
 * where `fn` resolves true once saved; while `deciding()`, the page skips its own
 * navigation to a newly saved item.
 */
export default function useDraftGuard(description, route) {
  const [dirty, setDirtyState] = useState(false),
    [pending, setPending] = useState(null),
    [busy, setBusy] = useState(false),
    [canSave, setCanSave] = useState(false);
  const dirtyRef = useRef(false),
    saveRef = useRef(null),
    routeRef = useRef(route),
    waiting = useRef(null),
    saving = useRef(false);
  routeRef.current = route;
  waiting.current = pending;
  const setDirty = useCallback((value) => {
    dirtyRef.current = value;
    setDirtyState(value);
  }, []);
  const setSave = useCallback((save) => {
    saveRef.current = save;
    setCanSave(Boolean(save));
  }, []);
  useEffect(() => {
    // An unmounted page refuses the navigation it was still asking about.
    let asking = null;
    const unregister = registerNavigationGuard((request) =>
      needsDecision(request, {
        dirty: dirtyRef.current,
        stays: (request) => keepsDraft(request.next, routeRef.current),
      })
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
  const finish = useCallback((accepted, discarded = false) => {
    const decision = waiting.current;
    waiting.current = null;
    setPending(null);
    decision?.resolve(accepted, discarded);
  }, []);
  const guarded = (go, discarded) =>
    dirtyRef.current
      ? setPending({
          resolve: (accepted, wasDiscarded) => {
            if (!accepted) return;
            if (wasDiscarded) discarded?.();
            go();
          },
        })
      : go();
  const onSave = async () => {
    if (saving.current || !saveRef.current) return;
    saving.current = true;
    setBusy(true);
    let saved = false;
    try {
      saved = Boolean(await saveRef.current());
    } finally {
      saving.current = false;
      setBusy(false);
    }
    // A failed save keeps the draft and shows its error in the editor.
    if (saved) setDirty(false);
    finish(saved);
  };
  const confirm = (
    <UnsavedChangesSheet
      open={Boolean(pending)}
      body={description}
      saveLabel={commonCopy.saveAndContinue}
      saveDisabled={!canSave}
      busy={busy}
      onSave={onSave}
      onDiscard={() => {
        setDirty(false);
        finish(true, true);
      }}
      onCancel={() => {
        if (!saving.current) finish(false);
      }}
    />
  );
  // True while the sheet decides: a save it started must not navigate to the saved
  // item, or that navigation would replace the one the sheet is deciding about.
  const deciding = useCallback(() => Boolean(waiting.current), []);
  return { setDirty, setSave, guarded, deciding, confirm };
}
