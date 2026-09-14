import { useContext, useSyncExternalStore } from "react";
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
    open: (path) => store.open(client, scopeId, path, limits, scope),
    activate: store.activate,
    edit: store.edit,
    format: store.format,
    close: store.close,
    save: store.save,
    saveAs: store.saveAs,
  };
}
