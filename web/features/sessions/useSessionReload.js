import { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import { sessionReloadCopy as copy } from "../../lib/i18n/messages/sessions.js";

export default function useSessionReload(session, pending) {
  const path = `/sessions/${encodeURIComponent(session.id)}/reload`;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const epoch = useRef(0);
  const submissionError = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function poll() {
      const version = epoch.current;
      try {
        const result = await api(path, "GET", undefined, controller.signal);
        if (
          !controller.signal.aborted &&
          !mutating.current &&
          version === epoch.current
        ) {
          setData(result);
          if (pending.current && pending.current.requestId === result.requestId) {
            pending.current = null;
            submissionError.current = false;
          }
          if (!submissionError.current) setError("");
        }
      } catch (err) {
        if (
          !controller.signal.aborted &&
          !mutating.current &&
          version === epoch.current &&
          !submissionError.current
        )
          setError(err.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
      }
    }
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, revision, pending]);
  async function submit(mode, interrupt = false, targetAccountId) {
    if (mutating.current) return;
    let body;
    try {
      body = pending.current || {
        mode,
        interrupt,
        requestId: crypto.randomUUID(),
        ...(targetAccountId ? { targetAccountId } : {}),
      };
    } catch {
      submissionError.current = true;
      setError(copy.prepareFailed);
      return;
    }
    pending.current = body;
    epoch.current++;
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
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function cancel() {
    if (mutating.current) return;
    epoch.current++;
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
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return {
    data,
    error,
    busy,
    submit,
    cancel,
    pending: pending.current,
    refresh: () => setRevision((value) => value + 1),
  };
}
