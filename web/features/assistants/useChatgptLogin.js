import { useEffect, useRef, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

const savedLogin = "agentpier-assistant-login";
export const activeAttempt = (attempt) =>
  ["starting", "awaiting_user"].includes(attempt?.status);

/**
 * The device-code login; a reload of the page resumes a login still waiting. While
 * an attempt is active it follows the live `job.chatgpt-login:current` topic (every
 * change of the attempt is pushed); a REST read, when the channel needs one, asks
 * for this attempt by its id.
 */
export default function useChatgptLogin({ reload }) {
  const [attempt, setAttempt] = useState(() => {
    const id = sessionStorage.getItem(savedLogin);
    return id ? { id, status: "starting" } : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = activeAttempt(attempt) ? attempt.id : null;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const {
    data,
    error: readError,
    refresh,
  } = useLiveTopic(
    id ? "job.chatgpt-login:current" : null,
    id ? `/assistant-model-login/${encodeURIComponent(id)}` : undefined,
  );
  useEffect(() => {
    if (!id || !data) return;
    // Another attempt's answer (an earlier one, or one that replaced this attempt):
    // this attempt's own route says what became of it (gone: 404, see below).
    if (data.id !== id) {
      void refresh();
      return;
    }
    setAttempt(data);
    if (!activeAttempt(data)) {
      sessionStorage.removeItem(savedLogin);
      void reloadRef.current();
    }
  }, [data, id, refresh]);
  useEffect(() => {
    if (!id || !readError) return;
    sessionStorage.removeItem(savedLogin);
    setAttempt({ id, status: "failed" });
    setError(readError);
  }, [readError, id]);
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
