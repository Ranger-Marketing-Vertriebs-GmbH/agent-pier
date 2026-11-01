import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { createView, deleteView, updateView } from "./views-api.js";
import { adoptViews, normalizeViews, withPending, withWrite } from "./views-model.js";

const empty = { version: 0, views: [] };

/**
 * The owner's split views, followed over the live topic `views` while `enabled`.
 * Writes run one after another; their answers are trusted, live frames older than
 * the last answer are ignored (views-model.js). Layout edits show at once (pending
 * over the confirmed document) and roll back with a reported error; a rename
 * rejects unreported, for the inline name field.
 */
export default function useViewsStore({ enabled }) {
  const live = useLiveTopic(enabled ? "views" : null);
  const confirmedRef = useRef(empty);
  const [confirmed, setConfirmed] = useState(empty);
  const [written, setWritten] = useState(false);
  const [pending, setPending] = useState([]);
  const [error, setError] = useState("");
  const [focusRequest, setFocusRequest] = useState(null);
  const queue = useRef(Promise.resolve());

  const keep = useCallback((next) => {
    confirmedRef.current = next;
    setConfirmed(next);
  }, []);
  useEffect(() => {
    if (!live.data) return;
    const next = adoptViews(confirmedRef.current, normalizeViews(live.data));
    if (next !== confirmedRef.current) keep(next);
  }, [live.data, keep]);

  // Runs `write()` after the earlier writes and applies its answer.
  const run = useCallback(
    (write, answerOf = (answer) => answer) => {
      const step = async () => {
        const answer = await write();
        keep(withWrite(confirmedRef.current, answerOf(answer)));
        setWritten(true);
        return answer;
      };
      const result = queue.current.then(step, step);
      queue.current = result.catch(() => {});
      return result;
    },
    [keep],
  );

  const create = useCallback(
    async ({ name, layout }) => (await run(() => createView({ name, layout }))).view,
    [run],
  );
  const rename = useCallback(
    async (id, name) => (await run(() => updateView(id, { name }))).view,
    [run],
  );
  const setLayout = useCallback(
    async (id, layout) => {
      const edit = { id, patch: { layout } };
      setPending((list) => [...list, edit]);
      try {
        const { view } = await run(() => updateView(id, { layout }));
        setError("");
        return view;
      } catch (failure) {
        setError(failure.message);
        return null;
      } finally {
        setPending((list) => list.filter((item) => item !== edit));
      }
    },
    [run],
  );
  const touch = useCallback(
    (id) => {
      run(() => updateView(id, { used: true })).catch(() => {});
    },
    [run],
  );
  const remove = useCallback(
    async (id) => {
      await run(
        () => deleteView(id),
        ({ version }) => ({ version, removedId: id }),
      );
    },
    [run],
  );
  const requestFocus = useCallback(
    (viewId, key) => setFocusRequest({ viewId, key, nonce: Symbol(key) }),
    [],
  );

  const document = useMemo(() => withPending(confirmed, pending), [confirmed, pending]);
  const byId = useCallback(
    (id) => document.views.find((view) => view.id === id) ?? null,
    [document],
  );
  return useMemo(
    () => ({
      views: document.views,
      loaded: Boolean(live.data) || written,
      error: error || live.error || "",
      byId,
      create,
      rename,
      setLayout,
      touch,
      remove,
      focusRequest,
      requestFocus,
    }),
    [
      document,
      live.data,
      written,
      error,
      live.error,
      byId,
      create,
      rename,
      setLayout,
      touch,
      remove,
      focusRequest,
      requestFocus,
    ],
  );
}
