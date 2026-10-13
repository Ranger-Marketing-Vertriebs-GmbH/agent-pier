import { useEffect, useState } from "react";
import api from "../../lib/api.js";

/**
 * The selected artifact: the list's row when it is on the current page, otherwise read
 * once by ID (a deep link, another page or another filter). `gone` after a 404.
 */
export default function useArtifactSummary(id, listed, revision) {
  const [state, setState] = useState(null);
  const isListed = Boolean(listed);
  useEffect(() => {
    if (!id || isListed) return undefined;
    const controller = new AbortController();
    api(`/artifacts/${encodeURIComponent(id)}`, "GET", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState({ id, value });
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setState({ id, gone: failure.status === 404, error: failure.message });
      });
    return () => controller.abort();
  }, [id, isListed, revision]);
  if (!id) return { item: null };
  if (listed) return { item: listed };
  if (state?.id !== id) return { item: null, loading: true };
  return { item: state.value || null, gone: state.gone, error: state.error };
}
