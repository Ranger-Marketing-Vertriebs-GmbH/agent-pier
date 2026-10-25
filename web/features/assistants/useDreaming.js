import { useCallback, useEffect, useState } from "react";
import { assistantApi } from "./assistant-api.js";

/**
 * The owner's dreaming setting (GET /assistant-dreaming), or null while it loads or
 * cannot be read: then nothing is locked and the server decides on save.
 */
export default function useDreaming() {
  const [dreaming, setDreaming] = useState(null);
  const refresh = useCallback(async () => {
    setDreaming(await assistantApi.dreaming());
  }, []);
  useEffect(() => {
    let active = true;
    assistantApi
      .dreaming()
      .then((next) => active && setDreaming(next))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return { dreaming, refresh };
}
