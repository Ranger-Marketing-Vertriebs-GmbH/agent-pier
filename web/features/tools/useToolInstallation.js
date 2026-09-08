import { useToolInstallationCopy as copy } from "../../lib/i18n/de/tools.js";
import { useEffect, useRef, useState, useCallback } from "react";
export default function useToolInstallation({ tool, request, refresh }) {
  const [job, setJob] = useState(null),
    [loading, setLoading] = useState(true),
    [globalBusy, setGlobalBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState("");
  const [ready, setReady] = useState(false),
    [syncing, setSyncing] = useState(false),
    [syncError, setSyncError] = useState("");
  const mounted = useRef(false),
    mutating = useRef(false),
    generation = useRef(0),
    synchronizing = useRef(false);
  const requestRef = useRef(request),
    refreshRef = useRef(refresh);
  requestRef.current = request;
  refreshRef.current = refresh;
  const invalidateRequests = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    mounted.current = true;
    let alive = true,
      timer;
    const poll = async () => {
      const version = generation.current;
      if (!mutating.current) {
        try {
          const result = await requestRef.current("/tool-installations");
          if (alive && version === generation.current && !mutating.current) {
            const found = result.installations?.find((item) => item.tool === tool);
            setJob(found || null);
            setGlobalBusy(Boolean(result.busy));
            setLoading(false);
            setLoadError(found ? "" : copy.installationUnavailable);
          }
        } catch (err) {
          if (alive && version === generation.current) {
            setLoadError(err.message);
            setLoading(false);
          }
        }
      }
      if (alive) timer = setTimeout(poll, 1500);
    };
    poll();
    return () => {
      alive = false;
      mounted.current = false;
      invalidateRequests();
      clearTimeout(timer);
    };
  }, [tool, invalidateRequests]);
  const synchronize = useCallback(async () => {
    if (synchronizing.current) return;
    synchronizing.current = true;
    setSyncing(true);
    setSyncError("");
    try {
      const state = await refreshRef.current();
      if (!mounted.current) return;
      const installed = [...(state?.tools || []), ...(state?.utilities || [])].some(
        (item) => item.id === tool && item.installed,
      );
      setReady(Boolean(installed));
      if (!installed) setSyncError(copy.cliNotDetected);
    } catch (err) {
      if (mounted.current) setSyncError(err.message);
    } finally {
      if (mounted.current) {
        synchronizing.current = false;
        setSyncing(false);
      }
    }
  }, [tool]);
  useEffect(() => {
    if (job?.status === "succeeded") synchronize();
    else setReady(false);
  }, [job?.status, job?.finishedAt, job?.version, synchronize]);
  async function install() {
    if (
      mutating.current ||
      !job?.available ||
      globalBusy ||
      job.status === "running" ||
      job.status === "succeeded"
    )
      return;
    mutating.current = true;
    generation.current++;
    setSubmitting(true);
    setError("");
    try {
      const result = await requestRef.current(`/tools/${tool}/install`, "POST", {});
      if (mounted.current) {
        setJob(result);
        setGlobalBusy(result.status === "running");
      }
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) {
        mutating.current = false;
        setSubmitting(false);
      }
    }
  }
  const running = job?.status === "running";
  const succeeded = job?.status === "succeeded";
  const utility = tool === "gh" || job?.utility;
  return {
    loading,
    job,
    running,
    submitting,
    globalBusy,
    succeeded,
    loadError,
    error,
    syncError,
    syncing,
    synchronize,
    ready,
    utility,
    install,
  };
}
