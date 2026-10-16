import { useEffect, useState } from "react";
import { directoryApi } from "./directory-api.js";

const installedVersions = (servers) =>
  new Map((servers || []).map((server) => [server.id, server.source?.version]));

/**
 * Directory updates by server id, asked on mount of the MCP list or a server overview
 * (an owner action) and again when the owner changes the package a directory server
 * runs; only when some server came from the directory. A failed request shows no pill.
 * An answer counts only for the installed versions it was asked about, so a version
 * that changed since then (to the listed one or past it) shows no stale pill or hint,
 * and neither does a listed version that is already installed.
 */
export default function useDirectoryUpdates(servers) {
  const [answer, setAnswer] = useState(() => ({ updates: new Map(), asked: new Map() }));
  const fromDirectory = (servers || []).filter((server) => server.directoryOrigin);
  const key = JSON.stringify(
    fromDirectory.map((server) => [server.id, server.source?.version ?? null]),
  );
  useEffect(() => {
    if (!fromDirectory.length) return undefined;
    let live = true;
    const asked = installedVersions(fromDirectory);
    directoryApi.updates().then(
      (result) => {
        if (!live) return;
        const list = Array.isArray(result?.updates) ? result.updates : [];
        setAnswer({
          updates: new Map(list.map((update) => [update.serverId, update])),
          asked,
        });
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // The key stands for the directory servers and their installed versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const installed = installedVersions(servers);
  const current = new Map();
  for (const [id, update] of answer.updates) {
    const version = installed.get(id);
    if (
      !update.version ||
      (version === answer.asked.get(id) && version !== update.version)
    )
      current.set(id, update);
    else if (update.hint) current.set(id, { ...update, version: undefined });
  }
  return current;
}
