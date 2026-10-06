import { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";

const IDLE = { busy: false, result: null, error: "" };

export default function useEndpointTest({ connection, draft, apiKey, removeApiKey }) {
  const [state, setState] = useState(IDLE);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function run(probeModelId) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ busy: true, result: null, error: "" });
    try {
      const result = await api(
        "/provider-connections/test",
        "POST",
        {
          ...(connection ? { connectionId: connection.id } : {}),
          endpoint: {
            preset: draft.preset,
            openaiBaseUrl: draft.openaiBaseUrl.trim(),
            anthropicBaseUrl: draft.anthropicBaseUrl.trim() || null,
            authHeader: draft.authHeader.trim() || null,
          },
          ...(apiKey ? { apiKey } : removeApiKey ? { apiKey: "" } : {}),
          ...(probeModelId ? { probeModelId } : {}),
        },
        current.signal,
      );
      if (current.signal.aborted) return null;
      setState({ busy: false, result, error: "" });
      return result;
    } catch (error) {
      if (!current.signal.aborted)
        setState({ busy: false, result: null, error: error.message });
      return null;
    }
  }
  /** Forgets a shown or running test, e.g. after the address or key changed. */
  function reset() {
    controller.current?.abort();
    controller.current = null;
    setState((current) =>
      current.busy || current.result || current.error ? IDLE : current,
    );
  }
  return { ...state, run, reset };
}
