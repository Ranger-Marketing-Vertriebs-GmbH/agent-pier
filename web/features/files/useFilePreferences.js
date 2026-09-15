import { useCallback, useEffect, useRef, useState } from "react";

const empty = { favorites: [], showHidden: false };

function obsolete() {
  return new DOMException("The file preference scope changed.", "AbortError");
}

export default function useFilePreferences({ client, scopeId }) {
  const ownerRef = useRef(null);
  const latest = useRef(empty);
  const queue = useRef(Promise.resolve());
  const readController = useRef(null);
  const readGeneration = useRef(0);
  const mutationControllers = useRef(new Set());
  if (
    !ownerRef.current ||
    ownerRef.current.client !== client ||
    ownerRef.current.scopeId !== scopeId
  ) {
    ownerRef.current = { client, scopeId };
    latest.current = empty;
    queue.current = Promise.resolve();
  }
  const owner = ownerRef.current;
  const [result, setResult] = useState({ owner: null, value: empty });
  const [failure, setFailure] = useState({ owner: null, error: null });
  const [readLoading, setReadLoading] = useState(null);
  const [mutations, setMutations] = useState({ owner: null, count: 0 });
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(
    () => () => {
      for (const item of mutationControllers.current)
        if (item.owner === owner) {
          item.controller.abort();
          mutationControllers.current.delete(item);
        }
    },
    [owner],
  );

  useEffect(() => {
    if (!client || !scopeId) {
      setResult({ owner, value: empty });
      setFailure({ owner, error: null });
      setReadLoading(null);
      return;
    }
    const controller = new AbortController();
    const request = ++readGeneration.current;
    readController.current?.abort();
    readController.current = controller;
    setResult({ owner, value: empty });
    setReadLoading(owner);
    setFailure({ owner, error: null });
    client
      .get("/preferences", {}, controller.signal)
      .then((result) => {
        if (
          !controller.signal.aborted &&
          ownerRef.current === owner &&
          request === readGeneration.current
        ) {
          latest.current = result;
          setResult({ owner, value: result });
        }
      })
      .catch((issue) => {
        if (
          !controller.signal.aborted &&
          ownerRef.current === owner &&
          request === readGeneration.current
        )
          setFailure({ owner, error: issue });
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          ownerRef.current === owner &&
          request === readGeneration.current
        )
          setReadLoading(null);
      });
    return () => {
      controller.abort();
      if (readController.current === controller) readController.current = null;
    };
  }, [client, generation, owner, scopeId]);

  const update = useCallback(
    (change) => {
      readController.current?.abort();
      readGeneration.current += 1;
      setReadLoading(null);
      setMutations((value) => ({
        owner,
        count: value.owner === owner ? value.count + 1 : 1,
      }));
      setFailure({ owner, error: null });
      const operation = queue.current
        .catch(() => {})
        .then(async () => {
          if (ownerRef.current !== owner) throw obsolete();
          const patch = typeof change === "function" ? change(latest.current) : change;
          const controller = new AbortController();
          const active = { owner, controller };
          mutationControllers.current.add(active);
          try {
            const value = await client.mutate("/preferences", {
              method: "PATCH",
              body: patch,
              scopeId,
              signal: controller.signal,
            });
            if (ownerRef.current !== owner) throw obsolete();
            latest.current = value;
            setResult({ owner, value });
            return value;
          } catch (issue) {
            if (ownerRef.current === owner && issue.name !== "AbortError")
              setFailure({ owner, error: issue });
            throw issue;
          } finally {
            mutationControllers.current.delete(active);
            setMutations((state) =>
              state.owner === owner
                ? { owner, count: Math.max(0, state.count - 1) }
                : state,
            );
          }
        });
      queue.current = operation;
      return operation;
    },
    [client, owner, scopeId],
  );

  return {
    preferences: result.owner === owner ? result.value : empty,
    error: failure.owner === owner ? failure.error : null,
    loading: readLoading === owner || (mutations.owner === owner && mutations.count > 0),
    update,
    refresh,
  };
}
