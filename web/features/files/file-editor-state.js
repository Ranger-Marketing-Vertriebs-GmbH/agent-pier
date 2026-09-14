export const emptyEditorState = () => ({ tabs: [], activeId: null });
export const requiresEditorRetention = (tab) =>
  Boolean(tab?.dirty || tab?.pending || tab?.attempt);
export const normalizedText = (text) => text.replace(/\r\n|\r/g, "\n");

export function editorReducer(state, action) {
  if (action.type === "open")
    return { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
  if (action.type === "activate")
    return state.tabs.some((tab) => tab.id === action.id)
      ? { ...state, activeId: action.id }
      : state;
  if (action.type === "close") {
    const tabs = state.tabs.filter((tab) => tab.id !== action.id);
    return {
      tabs,
      activeId: state.activeId === action.id ? (tabs.at(-1)?.id ?? null) : state.activeId,
    };
  }
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.id !== action.id) return tab;
      if (action.type === "loaded")
        return {
          ...tab,
          document: action.document,
          text: normalizedText(action.document.text),
          baselineText: normalizedText(action.document.text),
          format: { bom: action.document.bom, lineEnding: action.document.lineEnding },
          baselineFormat: {
            bom: action.document.bom,
            lineEnding: action.document.lineEnding,
          },
          loading: false,
        };
      if (action.type === "patch") return { ...tab, ...action.patch };
      if (action.type === "edit" || action.type === "format") {
        const next =
          action.type === "edit"
            ? { ...tab, ...action.patch }
            : { ...tab, format: { ...tab.format, ...action.patch } };
        const dirty =
          next.text !== next.baselineText ||
          next.format.bom !== next.baselineFormat.bom ||
          next.format.lineEnding !== next.baselineFormat.lineEnding;
        const changed =
          next.text !== tab.text ||
          next.format.bom !== tab.format.bom ||
          next.format.lineEnding !== tab.format.lineEnding;
        const refreshFeedback =
          changed &&
          ["saved", "modified", "unchanged", "dirty", "updated-during-save"].includes(
            tab.outcome?.status,
          );
        return {
          ...next,
          dirty,
          outcome: refreshFeedback
            ? { status: dirty ? "modified" : "unchanged" }
            : next.outcome,
        };
      }
      if (
        action.type === "saved" &&
        tab.attempt === action.attempt &&
        tab.baselineGeneration === action.attempt.baselineGeneration
      ) {
        const { attempt, result } = action;
        const dirty =
          tab.text !== attempt.text ||
          tab.format.bom !== attempt.format.bom ||
          tab.format.lineEnding !== attempt.format.lineEnding;
        return {
          ...tab,
          document: {
            ...tab.document,
            revision: result.revision,
            metadataRevision: result.metadataRevision,
          },
          baselineText: attempt.text,
          baselineFormat: attempt.format,
          baselineGeneration: tab.baselineGeneration + 1,
          dirty,
          pending: false,
          attempt: null,
          error: null,
          outcome: { status: dirty ? "updated-during-save" : "saved" },
        };
      }
      return tab;
    }),
  };
}
