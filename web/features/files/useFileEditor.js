import { useContext, useSyncExternalStore } from "react";
import { requiresEditorRetention } from "./file-editor-state.js";
import { FileEditorContext } from "./file-editor-context.jsx";

export default function useFileEditor({ client, scopeId, limits, scope }) {
  const store = useContext(FileEditorContext);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return {
    ...state,
    dirtyTabs: state.tabs.filter((tab) => tab.dirty),
    retainedTabs: state.tabs.filter(requiresEditorRetention),
    open: (path) => store.open(client, scopeId, path, limits, scope),
    activate: store.activate,
    edit: store.edit,
    format: store.format,
    close: store.close,
    save: store.save,
    saveAs: store.saveAs,
    saveAsFresh: (id, path, options) =>
      store.saveAsWith(id, client, scopeId, path, options),
    replace: store.replace,
    observe: store.observe,
    invalidateObservation: store.invalidateObservation,
    reload: store.reload,
    inspectConflict: store.inspectConflict,
    useCurrent: store.useCurrent,
    dismissConflict: store.dismissConflict,
  };
}
