import { requiresEditorRetention } from "./file-editor-state.js";

export const captureFileNavigationTab = (tab) => ({
  id: tab.id,
  client: tab.client,
  scopeId: tab.scopeId,
  path: tab.path,
  baselineGeneration: tab.baselineGeneration,
  baselineText: tab.baselineText,
  baselineFormat: tab.baselineFormat,
  text: tab.text,
  format: tab.format,
  attempt: tab.attempt,
});

const sameCapture = (tab, version) =>
  tab && version && Object.keys(version).every((key) => tab[key] === version[key]);

export function resolveFileNavigationTab(store, entry, { discard = false } = {}) {
  const tab = store.getSnapshot().tabs.find((item) => item.id === entry.id);
  if (!sameCapture(tab, entry)) {
    return requiresEditorRetention(tab)
      ? { status: "changed", entry: captureFileNavigationTab(tab) }
      : { status: "gone" };
  }
  if (discard) store.close(entry.id, { discard: true });
  return { status: "resolved" };
}
