import { useCallback, useEffect, useRef, useState } from "react";

export default function useFileListing({ client, path, page, sort, direction, hidden }) {
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const snapshot = useRef({ key: "", id: null });
  const key = JSON.stringify([path, sort, direction, hidden]);

  const refresh = useCallback(() => {
    snapshot.current = { key: "", id: null };
    setListing(null);
    setError(null);
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!client || path === null) {
      setListing(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (snapshot.current.key !== key) {
      snapshot.current = { key, id: null };
      setListing(null);
    }
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
          ...(snapshot.current.id ? { snapshot: snapshot.current.id } : {}),
        },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        snapshot.current = { key, id: result.snapshotId };
        setListing(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) {
          setListing(null);
          setError(issue);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, direction, generation, hidden, key, page, path, sort]);

  return { listing, error, loading, refresh };
}
