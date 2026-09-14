import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { FileEditorContext } from "./file-editor-context.jsx";
import { requiresEditorRetention } from "./file-editor-state.js";
import {
  registerFileNavigationGuard,
  requestFileNavigation,
} from "./file-navigation-guard.js";

export default function useFileNavigationGuard() {
  const store = useContext(FileEditorContext);
  const [snapshot, setSnapshot] = useState(store.getSnapshot);
  const [decision, setDecision] = useState(null);
  const hasRetainedTabs = snapshot.tabs.some(requiresEditorRetention);
  useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);
  useEffect(
    () =>
      registerFileNavigationGuard(
        (request) =>
          new Promise((resolve) => {
            const ids = store
              .getSnapshot()
              .tabs.filter(
                (tab) =>
                  requiresEditorRetention(tab) &&
                  (!request.tabId || request.tabId === tab.id),
              )
              .map((tab) => tab.id);
            if (!ids.length) return resolve(true);
            setDecision({ request, ids, position: 0, resolve, saving: false });
          }),
      ),
    [store],
  );
  useEffect(() => {
    if (!hasRetainedTabs) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasRetainedTabs]);
  const finish = useCallback((accepted) => {
    setDecision((current) => {
      current?.resolve(accepted);
      return null;
    });
  }, []);
  const advance = useCallback(
    (discard = false) => {
      setDecision((current) => {
        if (!current) return null;
        const id = current.ids[current.position];
        if (discard) store.close(id, { discard: true });
        const position = current.position + 1;
        if (position >= current.ids.length) {
          const ids = store
            .getSnapshot()
            .tabs.filter(
              (tab) =>
                requiresEditorRetention(tab) &&
                (!current.request.tabId || current.request.tabId === tab.id),
            )
            .map((tab) => tab.id);
          if (ids.length) return { ...current, ids, position: 0, saving: false };
          current.resolve(true);
          return null;
        }
        return { ...current, position, saving: false };
      });
    },
    [store],
  );
  const save = useCallback(async () => {
    const current = decision;
    if (!current || current.saving) return;
    setDecision({ ...current, saving: true });
    await store.save(current.ids[current.position]);
    const tab = store
      .getSnapshot()
      .tabs.find((item) => item.id === current.ids[current.position]);
    if (!requiresEditorRetention(tab)) advance();
    else setDecision((latest) => (latest ? { ...latest, saving: false } : latest));
  }, [advance, decision, store]);
  const tab = useMemo(
    () =>
      decision
        ? snapshot.tabs.find((item) => item.id === decision.ids[decision.position])
        : null,
    [decision, snapshot.tabs],
  );
  return {
    decision,
    tab,
    save,
    discard: () => advance(true),
    cancel: () => finish(false),
    requestClose: (id) =>
      requestFileNavigation({
        reason: "tab-close",
        tabId: id,
        commit: () => store.close(id, { discard: true }),
      }),
  };
}
