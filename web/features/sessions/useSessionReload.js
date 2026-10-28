import { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { sessionReloadCopy as copy } from "../../lib/i18n/messages/sessions.js";
import { browserUuid } from "../../lib/browser-uuid.js";

/**
 * Whether and how `session` can be reloaded, and the requests that reload it. The
 * state follows the live `session.reload:<id>` topic: the server pushes every change
 * of the reload and samples the CLI's activity while a visible tab watches. A push
 * that arrives while a request or cancel is sent is older than its answer and is
 * dropped; later pushes win again.
 */
export default function useSessionReload(session, pending) {
  const path = `/sessions/${encodeURIComponent(session.id)}/reload`;
  const live = useLiveTopic(`session.reload:${session.id}`);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const submissionError = useRef(false);
  // A push arrived while a request or cancel was sent (and was dropped).
  const dropped = useRef(false);
  const { refresh: reread } = live;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const result = live.data;
    if (!result) return;
    if (mutating.current) {
      dropped.current = true;
      return;
    }
    setData(result);
    if (pending.current && pending.current.requestId === result.requestId) {
      pending.current = null;
      submissionError.current = false;
    }
    if (!submissionError.current) setError("");
  }, [live.data, pending]);
  // A read the channel could not push (its fallback, a timeout) shows its failure.
  useEffect(() => {
    if (live.error && !mutating.current && !submissionError.current) setError(live.error);
  }, [live.error]);
  // The write's answer is shown; a push dropped meanwhile may be newer than it, so the
  // reload is read once more (its answer arrives as the topic's data).
  function settle() {
    mutating.current = false;
    if (mounted.current) setBusy(false);
    if (dropped.current && mounted.current) {
      dropped.current = false;
      void reread();
    }
  }
  async function submit(mode, interrupt = false, targetAccountId) {
    if (mutating.current) return;
    let body;
    try {
      body = pending.current || {
        mode,
        interrupt,
        requestId: browserUuid(),
        ...(targetAccountId ? { targetAccountId } : {}),
      };
    } catch {
      submissionError.current = true;
      setError(copy.prepareFailed);
      return;
    }
    pending.current = body;
    mutating.current = true;
    setBusy(true);
    submissionError.current = false;
    setError("");
    try {
      const result = await api(path, "POST", body);
      if (pending.current?.requestId === body.requestId) pending.current = null;
      if (mounted.current) setData(result);
    } catch (err) {
      const rejected = err.status >= 400 && err.status < 500 && err.status !== 408;
      if (rejected && pending.current?.requestId === body.requestId)
        pending.current = null;
      submissionError.current = true;
      if (mounted.current) setError(rejected ? err.message : copy.requestFailed);
    } finally {
      settle();
    }
  }
  async function cancel() {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      const result = await api(path, "DELETE");
      pending.current = null;
      if (mounted.current) {
        setData(result);
        submissionError.current = false;
        setError("");
      }
    } catch (err) {
      submissionError.current = true;
      if (mounted.current) setError(err.message);
    } finally {
      settle();
    }
  }
  return {
    data,
    error,
    busy,
    submit,
    cancel,
    pending: pending.current,
    refresh: () => void live.refresh(),
  };
}
