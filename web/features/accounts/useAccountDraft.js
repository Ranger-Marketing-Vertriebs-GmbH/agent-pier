import { useCallback, useEffect, useRef, useState } from "react";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import { screenOf } from "../../app/route-screens.js";

/**
 * Whether a navigation keeps `entry` on screen: the same Accounts item and, for the
 * MCP wizard's edit steps, the same step. Each edit step keeps its own draft.
 */
export const staysOnEntry = (entry, request) => {
  // Old Accounts routes and their new places (Zugänge, Coding) compare alike; Coding's
  // Accounts tab holds the former section "cli".
  const next = screenOf(request.next);
  const section =
    next?.view === "coding" ? next.codingTab === "accounts" && "cli" : next?.section;
  return (
    ["accounts", "connections", "coding"].includes(next?.view) &&
    section === entry.section &&
    next.item === entry.item &&
    (next.step ?? "") === (entry.step ?? "")
  );
};

/**
 * One entry's draft and its unsaved-changes guard. Navigations that keep the same
 * entry on screen never ask; the steps are read at save time. After a full save the
 * draft restarts from the server record (one render later, when the refreshed record
 * has arrived), so typed keys and secret values never stay in the form and a
 * "remove key" checkbox does not stay ticked when the record itself did not change.
 *
 * `generation` counts every restart (save, Cancel, Discard, Reload) so fields with
 * their own view state (KeyField's "Replace") can return to it. `gate` holds the
 * save bar's check (form validity, `saveDisabled`); every save path — the bar,
 * Enter, "Overwrite anyway" and "Save and switch" — asks it first.
 */
export default function useAccountDraft({
  server,
  revisions,
  tab,
  entry,
  steps,
  refresh,
}) {
  const tabDraft = useTabDraft({ server, revisions, refresh });
  const current = useRef(steps);
  current.current = steps;
  const gate = useRef(null);
  const [savedCount, setSavedCount] = useState(0);
  const [generation, setGeneration] = useState(0);
  const {
    save: saveDraft,
    overwrite: overwriteDraft,
    reset: resetDraft,
    reload: reloadDraft,
  } = tabDraft;
  const reset = useCallback(() => {
    resetDraft();
    setGeneration((value) => value + 1);
  }, [resetDraft]);
  const reload = useCallback(async () => {
    await reloadDraft();
    setGeneration((value) => value + 1);
  }, [reloadDraft]);
  const settle = useCallback((result) => {
    if (result?.status === "saved") setSavedCount((value) => value + 1);
    return result;
  }, []);
  const save = useCallback(async () => {
    if (gate.current?.() === false) return { status: "blocked" };
    return settle(await saveDraft(current.current));
  }, [saveDraft, settle]);
  const overwrite = useCallback(async () => {
    if (gate.current?.() === false) return { status: "blocked" };
    return settle(await overwriteDraft(current.current));
  }, [overwriteDraft, settle]);
  useEffect(() => {
    if (savedCount) reset();
  }, [savedCount, reset]);
  // After the record behind the draft is gone (deleted, removed), the draft is dropped
  // first and the page navigates once that clean draft has rendered, so the unsaved
  // changes sheet never asks about a record that no longer exists.
  const [leaving, setLeaving] = useState(null);
  const leave = useCallback(
    (navigate, route) => {
      resetDraft();
      setLeaving({ navigate, route });
    },
    [resetDraft],
  );
  useEffect(() => {
    if (leaving && !tabDraft.dirty) leaving.navigate(leaving.route, true);
  }, [leaving, tabDraft.dirty]);
  const draft = { ...tabDraft, reset, reload };
  const sheet = useUnsavedChangesGuard({
    draft,
    tab,
    save,
    stays: (request) => staysOnEntry(entry, request),
  });
  return { draft, sheet, save, overwrite, generation, gate, leave };
}
