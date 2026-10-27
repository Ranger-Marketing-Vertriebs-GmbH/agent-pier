import { useEffect, useState } from "react";
import api from "../../../lib/api.js";
import { startVisiblePolling } from "../../../lib/visible-polling.js";

const polledTools = ["claude", "codex", "opencode"];

// Only native CLI logins without a stored key have a sign-in state to read.
const polled = (account) =>
  !account.provider &&
  !account.internal &&
  !account.hasSecret &&
  polledTools.includes(account.tool);

/**
 * The CLI sign-in state of every native account, polled every 30 s. The page owns
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
    const settle = (id, state) =>
      setStates((previous) =>
        previous[id] === state ? previous : { ...previous, [id]: state },
      );
    async function poll(id, signal) {
      try {
        const result = await api(`/accounts/${id}/auth-status`, "GET", undefined, signal);
        if (!signal.aborted) settle(id, result.state || "unknown");
      } catch {
        if (!signal.aborted) settle(id, "unknown");
      }
    }
    const stops = key
      .split("\n")
      .map((id) => startVisiblePolling((signal) => poll(id, signal), 30000));
    return () => stops.forEach((stop) => stop());
  }, [key]);
  return states;
}

export const authOf = (states, account) => states?.[account.id] || "unknown";
