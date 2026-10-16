import { useEffect, useState } from "react";
import { directoryApi } from "./directory-api.js";

/**
 * Directory updates by server id, asked once per mount of the MCP list or a server
 * overview (an owner action); only when some server came from the directory. A failed
 * request shows no pill.
 */
export default function useDirectoryUpdates(servers) {
  const [updates, setUpdates] = useState(() => new Map());
  const wanted = (servers || []).some((server) => server.directoryOrigin);
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    directoryApi.updates().then(
      (result) => {
        if (!live) return;
        const list = Array.isArray(result?.updates) ? result.updates : [];
        setUpdates(new Map(list.map((update) => [update.serverId, update])));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  return updates;
}
