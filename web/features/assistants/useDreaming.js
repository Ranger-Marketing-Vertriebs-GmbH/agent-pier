import { useCallback, useEffect, useState } from "react";
import { assistantApi } from "./assistant-api.js";

/**
 * The owner's dreaming setting (GET /assistant-dreaming), or null while it loads or
 * cannot be read (`error` says why): then nothing is locked and the server decides
 * on save.
 */
export default function useDreaming() {
  const [dreaming, setDreaming] = useState(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setDreaming(await assistantApi.dreaming());
    setError("");
  }, []);
  useEffect(() => {
    let active = true;
    assistantApi
      .dreaming()
      .then((next) => active && setDreaming(next))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  return { dreaming, error, refresh };
}
