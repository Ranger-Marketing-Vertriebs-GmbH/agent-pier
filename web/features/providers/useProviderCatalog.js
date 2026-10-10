import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";

export default function useProviderCatalog(
  providerId,
  tool,
  { autoRefresh = false } = {},
) {
  const key = `${providerId}:${tool}`;
  const [resource, setResource] = useState({ key: "", models: [], status: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloading, setReloading] = useState(false);
  const generation = useRef(0);
  const invalidateRequests = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    const version = ++generation.current;
    const controller = new AbortController();
    setError("");
    setReloading(false);
    if (!providerId) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    api(
      `/providers/${encodeURIComponent(providerId)}/models${tool ? `?tool=${encodeURIComponent(tool)}` : ""}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(async (result) => {
        if (version !== generation.current) return;
        setResource({ key, models: result.models || [], status: result.status });
        if (autoRefresh && result.status?.stale) {
          setLoading(false);
          setReloading(true);
          const fresh = await api(
            `/providers/${encodeURIComponent(providerId)}/refresh`,
            "POST",
            {},
            controller.signal,
          );
          if (version === generation.current)
            setResource({ key, models: fresh.models || [], status: fresh.status });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && version === generation.current)
          setError(error.message);
      })
      .finally(() => {
        if (version === generation.current) {
          setLoading(false);
          setReloading(false);
        }
      });
    return () => {
      invalidateRequests();
      controller.abort();
    };
  }, [providerId, tool, key, invalidateRequests, autoRefresh]);
  const refresh = useCallback(async () => {
    if (!providerId || reloading) return;
    const version = ++generation.current;
    setReloading(true);
    setError("");
    try {
      const result = await api(
        `/providers/${encodeURIComponent(providerId)}/refresh`,
        "POST",
        {},
      );
      if (version === generation.current)
        setResource({ key, models: result.models || [], status: result.status });
    } catch (error) {
      if (version === generation.current) {
        setError(error.message);
        setResource((current) => ({
          ...current,
          status: { ...current.status, stale: true },
        }));
      }
    } finally {
      if (version === generation.current) setReloading(false);
    }
  }, [providerId, reloading, key]);
  const current = resource.key === key;
  return {
    models: current
      ? resource.models.filter((model) => !tool || model.tools?.includes(tool))
      : [],
    status: current ? resource.status : null,
    loading: loading || Boolean(providerId && !current && !error),
    error,
    refresh,
    reloading,
  };
}
