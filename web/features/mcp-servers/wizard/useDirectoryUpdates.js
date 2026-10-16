import { useEffect, useState } from "react";
import { directoryApi } from "./directory-api.js";

/**
 * Directory updates by server id, asked once per mount of the MCP list or a server
 * overview (an owner action); only when some server came from the directory. A failed
 * request shows no pill. The list is not asked again after the owner updates a package,
 * so a listed version the server now runs is dropped here: pill and hint go once the
 * reloaded server reports it installed.
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
  const installed = new Map((servers || []).map((s) => [s.id, s.source?.version]));
  const current = new Map();
  for (const [id, update] of updates) {
    if (!update.version || update.version !== installed.get(id)) current.set(id, update);
    else if (update.hint) current.set(id, { ...update, version: undefined });
  }
  return current;
}
