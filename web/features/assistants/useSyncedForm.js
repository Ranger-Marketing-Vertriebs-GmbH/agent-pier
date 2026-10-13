import useTabDraft from "../../lib/settings/useTabDraft.js";

// Form values that follow the saved server record without discarding edits; kept
// for callers that save on their own (see useTabDraft for the tab save chain).
export default function useSyncedForm(server) {
  const draft = useTabDraft({ server });
  return {
    values: draft.values,
    set: draft.set,
    conflicts: draft.conflicts,
    reload: draft.reload,
    dirty: draft.dirty,
  };
}
