import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  changedKeys,
  followRevisions,
  followServer,
  sameValue,
  settleSave,
} from "./draft-state.js";
import { completedLabels, runSaveChain } from "./save-chain.js";

const empty = {};

/**
 * One tab's draft of server fields. Untouched fields follow the server; the base
 * revisions freeze at the first edit so a foreign change surfaces as a conflict.
 * `refresh()` fetches the record again after a conflict and resolves to the fresh
 * `{ server, revisions }`. See docs/settings-pattern.md for the save-chain protocol.
 */
export default function useTabDraft({
  server: record,
  revisions = empty,
  countChanges,
  refresh,
} = {}) {
  // A tab may pass nothing while it loads.
  const server = record ?? empty;
  const [state, setState] = useState(() => ({ values: server, base: server }));
  const [conflicts, setConflicts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const current = useRef(state);
  current.current = state;
  const latest = useRef({ server, revisions });
  latest.current = { server, revisions };
  const refresher = useRef(refresh);
  refresher.current = refresh;
  const baseRevisions = useRef(revisions);
  const running = useRef(null);
  const signature = JSON.stringify(server);
  useEffect(() => {
    const next = followServer(current.current, server);
    if (next.values !== current.current.values || next.base !== current.current.base) {
      current.current = { values: next.values, base: next.base };
      setState(current.current);
    }
    setConflicts((previous) =>
      sameValue(previous, next.conflicts) ? previous : next.conflicts,
    );
    // `signature` captures every change of `server`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const changed = useMemo(() => changedKeys(state.values, state.base), [state]);
  const dirty = changed.length > 0;
  const revisionSignature = JSON.stringify(revisions);
  useEffect(() => {
    if (!dirty)
      baseRevisions.current = followRevisions(
        baseRevisions.current,
        latest.current.revisions,
      );
  }, [dirty, revisionSignature]);
  const set = useCallback(
    (key, value) =>
      setState((previous) => ({
        ...previous,
        values: { ...previous.values, [key]: value },
      })),
    [],
  );
  const update = useCallback(
    (patch) =>
      setState((previous) => ({ ...previous, values: { ...previous.values, ...patch } })),
    [],
  );
  // The record as the page now knows it: what `refresh` returns wins over the props,
  // which only change on the next render.
  const pull = useCallback(async () => {
    if (!refresher.current) return latest.current;
    try {
      const fresh = (await refresher.current()) || {};
      return {
        server: fresh.server ?? latest.current.server,
        revisions: followRevisions(
          latest.current.revisions,
          fresh.revisions ?? latest.current.revisions,
        ),
      };
    } catch {
      return latest.current;
    }
  }, []);
  const restore = useCallback(({ server: next, revisions: nextRevisions }) => {
    current.current = { values: next, base: next };
    setState(current.current);
    setConflicts([]);
    setOutcome(null);
    baseRevisions.current = followRevisions(baseRevisions.current, nextRevisions);
  }, []);
  const reset = useCallback(() => restore(latest.current), [restore]);
  const reload = useCallback(async () => restore(await pull()), [pull, restore]);
  const run = useCallback(
    async (steps) => {
      setSaving(true);
      setOutcome(null);
      const { values, base } = current.current;
      const before = latest.current.server;
      try {
        const result = await runSaveChain({
          steps,
          values,
          base,
          revisions: baseRevisions.current,
          ask: (request) =>
            new Promise((resolve) =>
              setConfirmation({
                ...request,
                confirm: () => {
                  setConfirmation(null);
                  resolve(true);
                },
                cancel: () => {
                  setConfirmation(null);
                  resolve(false);
                },
              }),
            ),
        });
        baseRevisions.current = result.revisions;
        const complete = result.status === "saved";
        const savedKeys = complete
          ? Object.keys({ ...base, ...values })
          : result.savedKeys || [];
        setState((previous) => {
          const next = settleSave({
            draft: previous,
            submitted: values,
            savedKeys,
            before,
            server: latest.current.server,
          });
          return next.values === previous.values && next.base === previous.base
            ? previous
            : next;
        });
        setConflicts((previous) => {
          const next = previous.filter((key) => !savedKeys.includes(key));
          return next.length === previous.length ? previous : next;
        });
        const stopped =
          result.status === "error" ||
          result.status === "conflict" ||
          (result.status === "cancelled" && result.completed.length > 0);
        setOutcome(
          stopped ? { ...result, partial: completedLabels(steps, result) } : null,
        );
        if (result.status === "conflict" && refresher.current) {
          // Show the foreign change even when the page does not push it into `server`.
          const fresh = await pull();
          setConflicts(followServer(current.current, fresh.server).conflicts);
          setState((previous) => {
            const next = followServer(previous, fresh.server);
            return next.values === previous.values && next.base === previous.base
              ? previous
              : { values: next.values, base: next.base };
          });
        }
        return result;
      } finally {
        setSaving(false);
      }
    },
    [pull],
  );
  // A save started while one runs waits for that one instead of refusing.
  const save = useCallback(
    (steps) => {
      if (running.current) return running.current;
      const promise = run(steps).finally(() => {
        running.current = null;
      });
      running.current = promise;
      return promise;
    },
    [run],
  );
  const overwrite = useCallback(
    async (steps) => {
      if (running.current) return running.current;
      const { revisions: latestRevisions } = await pull();
      baseRevisions.current = followRevisions(baseRevisions.current, latestRevisions);
      return save(steps);
    },
    [pull, save],
  );
  const revisionsOf = useCallback(() => ({ ...baseRevisions.current }), []);
  return {
    values: state.values,
    base: state.base,
    set,
    update,
    dirty,
    changedKeys: changed,
    changeCount: countChanges ? countChanges(state.values, state.base) : changed.length,
    conflicts,
    saving,
    outcome,
    confirmation,
    save,
    overwrite,
    reset,
    reload,
    revisions: revisionsOf,
  };
}
