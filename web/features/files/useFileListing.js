import { useCallback, useEffect, useRef, useState } from "react";

function owns(result, owner, checkGeneration = true) {
  return (
    result?.client === owner.client &&
    result.path === owner.path &&
    result.page === owner.page &&
    result.sort === owner.sort &&
    result.direction === owner.direction &&
    result.hidden === owner.hidden &&
    (!checkGeneration || result.generation === owner.generation)
  );
}

function ownsSnapshot(snapshot, owner) {
  return (
    snapshot?.client === owner.client &&
    snapshot.path === owner.path &&
    snapshot.sort === owner.sort &&
    snapshot.direction === owner.direction &&
    snapshot.hidden === owner.hidden
  );
}

export default function useFileListing({ client, path, page, sort, direction, hidden }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const requestGeneration = useRef(0);
  const afterRefresh = useRef(null);
  const focusOwner = useRef(null);
  const nextFocusOwner = { client, path, page, sort, direction, hidden };
  if (
    focusOwner.current &&
    Object.keys(nextFocusOwner).some(
      (key) => focusOwner.current[key] !== nextFocusOwner[key],
    )
  )
    afterRefresh.current = null;
  focusOwner.current = nextFocusOwner;
  const snapshot = useRef(null);
  const owner = { client, path, page, sort, direction, hidden, generation };
  const listing = owns(result, owner) ? result.listing : null;
  const refreshing = Boolean(!listing && owns(result, owner, false));

  const refresh = useCallback((complete) => {
    if (typeof complete === "function") afterRefresh.current = complete;
    snapshot.current = null;
    setError(null);
    setGeneration((value) => value + 1);
  }, []);
  useEffect(
    () => () => {
      afterRefresh.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!listing || !afterRefresh.current) return;
    const complete = afterRefresh.current;
    afterRefresh.current = null;
    complete();
  }, [listing]);

  useEffect(() => {
    const request = ++requestGeneration.current;
    if (!client || path === null) {
      snapshot.current = null;
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    const snapshotOwner = { client, path, sort, direction, hidden };
    const snapshotId = ownsSnapshot(snapshot.current, snapshotOwner)
      ? snapshot.current.id
      : null;
    if (!snapshotId) snapshot.current = null;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client
      .get(
        "/entries",
        {
          path,
          page,
          sort,
          direction,
          hidden: hidden ? 1 : 0,
          ...(snapshotId ? { snapshot: snapshotId } : {}),
        },
        controller.signal,
      )
      .then((listing) => {
        if (controller.signal.aborted || request !== requestGeneration.current) return;
        snapshot.current = { ...snapshotOwner, id: listing.snapshotId };
        setResult({
          client,
          path,
          page,
          sort,
          direction,
          hidden,
          generation,
          listing,
        });
      })
      .catch((issue) => {
        if (controller.signal.aborted || request !== requestGeneration.current) return;
        afterRefresh.current = null;
        setResult(null);
        setError(issue);
      })
      .finally(() => {
        if (!controller.signal.aborted && request === requestGeneration.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [client, direction, generation, hidden, page, path, sort]);

  return { listing, error, loading, refreshing, refresh };
}
