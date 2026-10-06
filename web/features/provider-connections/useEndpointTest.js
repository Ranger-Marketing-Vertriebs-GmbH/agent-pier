import { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";

export default function useEndpointTest({ connection, draft, apiKey, removeApiKey }) {
  const [state, setState] = useState({ busy: false, result: null, error: "" });
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
  return { ...state, run };
}
