import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { FileEditorContext } from "./file-editor-context.jsx";
import { requiresEditorRetention } from "./file-editor-state.js";
import {
  registerFileNavigationGuard,
  requestFileNavigation,
} from "./file-navigation-guard.js";
import {
  captureFileNavigationTab,
  resolveFileNavigationTab,
} from "./file-navigation-decision.js";

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
            const entries = store
              .getSnapshot()
              .tabs.filter(
                (tab) =>
                  requiresEditorRetention(tab) &&
                  (!request.tabId || request.tabId === tab.id),
              )
              .map(captureFileNavigationTab);
            if (!entries.length) return resolve(true);
            setDecision({
              token: Symbol("file-navigation-decision"),
              request,
              entries,
              position: 0,
              resolve,
              saving: false,
            });
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
  const finish = useCallback((token, accepted) => {
    setDecision((current) => {
      if (!current || current.token !== token || current.saving) return current;
      current?.resolve(accepted);
      return null;
    });
  }, []);
  const advance = useCallback(
    (token, discard = false) => {
      setDecision((current) => {
        if (!current || current.token !== token) return current;
        const entry = current.entries[current.position];
        const resolution = resolveFileNavigationTab(store, entry, { discard });
        if (resolution.status !== "resolved") {
          if (resolution.status === "gone") {
            const entries = current.entries.filter((item) => item !== entry);
            if (entries.length)
              return {
                ...current,
                entries,
                position: Math.min(current.position, entries.length - 1),
                saving: false,
              };
          } else {
            const entries = [...current.entries];
            entries[current.position] = resolution.entry;
            return { ...current, entries, saving: false };
          }
        }
        const position = current.position + 1;
        if (position >= current.entries.length) {
          const entries = store
            .getSnapshot()
            .tabs.filter(
              (tab) =>
                requiresEditorRetention(tab) &&
                (!current.request.tabId || current.request.tabId === tab.id),
            )
            .map(captureFileNavigationTab);
          if (entries.length) return { ...current, entries, position: 0, saving: false };
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
    const entry = current.entries[current.position];
    if (resolveFileNavigationTab(store, entry).status !== "resolved")
      return advance(current.token);
    setDecision({ ...current, saving: true });
    await store.save(entry.id);
    const tab = store.getSnapshot().tabs.find((item) => item.id === entry.id);
    if (!requiresEditorRetention(tab)) advance(current.token);
    else
      setDecision((latest) => {
        if (!latest || latest.token !== current.token) return latest;
        const entries = [...latest.entries];
        entries[latest.position] = captureFileNavigationTab(tab);
        return { ...latest, entries, saving: false };
      });
  }, [advance, decision, store]);
  const tab = useMemo(
    () =>
      decision
        ? snapshot.tabs.find(
            (item) => item.id === decision.entries[decision.position]?.id,
          )
        : null,
    [decision, snapshot.tabs],
  );
  return {
    decision,
    tab,
    save,
    discard: () => decision && advance(decision.token, true),
    cancel: () => decision && finish(decision.token, false),
    requestClose: (id) =>
      requestFileNavigation({
        reason: "tab-close",
        tabId: id,
        commit: () => store.close(id, { discard: true }),
      }),
  };
}
