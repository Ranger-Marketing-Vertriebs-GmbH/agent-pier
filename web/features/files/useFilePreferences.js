import { useCallback, useEffect, useState } from "react";

const empty = { favorites: [], showHidden: false };

export default function useFilePreferences({ client, scopeId }) {
  const [preferences, setPreferences] = useState(empty);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (!client || !scopeId) {
      setPreferences(empty);
      return;
    }
    const controller = new AbortController();
    setPreferences(empty);
    setLoading(true);
    setError(null);
    client
      .get("/preferences", {}, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPreferences(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, generation, scopeId]);

  const update = useCallback(
    async (patch) => {
      setLoading(true);
      setError(null);
      try {
        const result = await client.mutate("/preferences", {
          method: "PATCH",
          body: patch,
          scopeId,
        });
        setPreferences(result);
        return result;
      } catch (issue) {
        setError(issue);
        throw issue;
      } finally {
        setLoading(false);
      }
    },
    [client, scopeId],
  );

  return { preferences, error, loading, update, refresh };
}
