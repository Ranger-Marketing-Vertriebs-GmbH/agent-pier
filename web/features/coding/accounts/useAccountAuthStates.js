import { useEffect, useState } from "react";
import api from "../../../lib/api.js";
import { liveClient } from "../../../lib/live/live-client.js";
import { startLiveTopic } from "../../../lib/live/live-topic-reader.js";

const followedTools = ["claude", "codex", "opencode"];

// Only native CLI logins without a stored key have a sign-in state to read.
const followed = (account) =>
  !account.provider &&
  !account.internal &&
  !account.hasSecret &&
  followedTools.includes(account.tool);

const restRead = (path, signal) => api(path, "GET", undefined, signal);

/**
 * The CLI sign-in state of every native account, each followed as the live topic
 * `account.auth:<id>`: the server samples it every 30 s while a visible tab watches
 * and pushes changes (without the channel the route is polled every 30 s, visible
 * tabs only). The page owns one copy and hands it to the hub rows and the open
 * detail, so an account is never followed twice. Returns `{ [accountId]:
 * "authenticated" | … }`; unknown ids are absent.
 */
export default function useAccountAuthStates(accounts) {
  const [states, setStates] = useState({});
  const key = (accounts || [])
    .filter(followed)
    .map((account) => account.id)
    .join("\n");
  useEffect(() => {
    if (!key) return undefined;
    const settle = (id, state) =>
      setStates((previous) =>
        previous[id] === state ? previous : { ...previous, [id]: state },
      );
    const client = liveClient();
    const readers = key.split("\n").map((id) =>
      startLiveTopic({
        topicId: `account.auth:${id}`,
        client,
        read: restRead,
        report: ({ data, error }) => {
          if (error) settle(id, "unknown");
          else if (data) settle(id, data.state || "unknown");
        },
      }),
    );
    return () => {
      readers.forEach((reader) => reader.stop());
      // What these subscriptions held is dropped: a later one starts from unknown.
      setStates({});
    };
  }, [key]);
  return states;
}

export const authOf = (states, account) => states?.[account.id] || "unknown";
