import { useState } from "react";
import { assistantApi } from "./assistant-api.js";
import usePolling from "./usePolling.js";

const savedLogin = "agentpier-assistant-login";
export const activeAttempt = (attempt) =>
  ["starting", "awaiting_user"].includes(attempt?.status);

/** The device-code login; a reload of the page resumes a login still waiting. */
export default function useChatgptLogin({ reload }) {
  const [attempt, setAttempt] = useState(() => {
    const id = sessionStorage.getItem(savedLogin);
    return id ? { id, status: "starting" } : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = activeAttempt(attempt) ? attempt.id : null;
  usePolling(
    async (signal) => {
      try {
        const next = await assistantApi.loginStatus(id);
        if (signal.aborted) return;
        setAttempt(next);
        if (!activeAttempt(next)) {
          sessionStorage.removeItem(savedLogin);
          await reload();
        }
      } catch (failure) {
        if (!signal.aborted) {
          sessionStorage.removeItem(savedLogin);
          setAttempt({ id, status: "failed" });
          setError(failure.message);
        }
      }
    },
    1000,
    { enabled: !!id, restartKey: id },
  );
  async function perform(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return {
    attempt,
    active: activeAttempt(attempt),
    busy,
    error,
    perform,
    start: () =>
      perform(async () => {
        const next = await assistantApi.startLogin();
        sessionStorage.setItem(savedLogin, next.id);
        setAttempt(next);
      }),
    cancel: () =>
      perform(async () => {
        setAttempt(await assistantApi.cancelLogin(attempt.id));
        sessionStorage.removeItem(savedLogin);
        await reload();
      }),
  };
}
