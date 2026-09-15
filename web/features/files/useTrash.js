import { useEffect, useRef, useState } from "react";
import { fileErrorMessage } from "../../lib/i18n/messages/files.js";

export default function useTrash(client, scopeId) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState(null);
  const generation = useRef(0);
  const current =
    result?.client === client && result.scopeId === scopeId && result.version === version
      ? result
      : null;
  useEffect(() => {
    const controller = new AbortController(),
      request = ++generation.current;
    const owned = () => !controller.signal.aborted && generation.current === request;
    const accept = (patch) => {
      if (owned()) setResult({ client, scopeId, version, ...patch });
    };
    const read = async () => {
      const entries = new Map(),
        seen = new Set();
      let cursor;
      try {
        do {
          const page = await client.get("/trash", { cursor }, controller.signal);
          if (!owned()) return;
          if (
            !Array.isArray(page.entries) ||
            (page.nextCursor && seen.has(page.nextCursor))
          )
            throw new Error(fileErrorMessage("FILE_INVALID_RESPONSE", 500));
          for (const item of page.entries) entries.set(item.id, item);
          cursor = page.nextCursor;
          if (cursor) seen.add(cursor);
        } while (cursor);
        accept({ entries: [...entries.values()], loading: false, error: null });
      } catch (error) {
        accept({ entries: [], loading: false, error });
      }
    };
    read();
    return () => controller.abort();
  }, [client, scopeId, version]);
  return {
    entries: current?.entries || [],
    loading: current?.loading ?? true,
    error: current?.error,
    refresh: () => setVersion((value) => value + 1),
  };
}
