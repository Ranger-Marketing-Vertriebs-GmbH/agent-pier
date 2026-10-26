import { useEffect, useState } from "react";
import api from "../../../lib/api.js";

const polledTools = ["claude", "codex", "opencode"];

// Only native CLI logins without a stored key have a sign-in state to read.
const polled = (account) =>
  !account.provider &&
  !account.internal &&
  !account.hasSecret &&
  polledTools.includes(account.tool);

/**
 * The CLI sign-in state of every native account, polled every 10 s. The page owns
 * one copy and hands it to the hub rows and the open detail, so an account is never
 * polled twice. Returns `{ [accountId]: "authenticated" | … }`; unknown ids are absent.
 */
export default function useAccountAuthStates(accounts) {
  const [states, setStates] = useState({});
  const key = (accounts || [])
    .filter(polled)
    .map((account) => account.id)
    .join("\n");
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const timers = new Set();
    const settle = (id, state) =>
      setStates((previous) =>
        previous[id] === state ? previous : { ...previous, [id]: state },
      );
    async function poll(id) {
      try {
        const result = await api(
          `/accounts/${id}/auth-status`,
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) settle(id, result.state || "unknown");
      } catch {
        if (!controller.signal.aborted) settle(id, "unknown");
      }
      if (!controller.signal.aborted) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          poll(id);
        }, 10000);
        timers.add(timer);
      }
    }
    key.split("\n").forEach(poll);
    return () => {
      controller.abort();
      timers.forEach(clearTimeout);
    };
  }, [key]);
  return states;
}

export const authOf = (states, account) => states?.[account.id] || "unknown";
