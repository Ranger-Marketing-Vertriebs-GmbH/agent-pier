import { useToolInstallationCopy as copy } from "../../lib/i18n/messages/tools.js";
import { useEffect, useRef, useState, useCallback } from "react";
import { apiCopy } from "../../lib/i18n/messages/components.js";
import { startVisiblePolling, timedOut } from "../../lib/visible-polling.js";
import { toolPollDelay } from "./tool-installation-poll.js";
export default function useToolInstallation({ tool, request, refresh, update = false }) {
  const [attempted, setAttempted] = useState(false);
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
    synchronizing = useRef(false),
    polling = useRef(false),
    observedRunning = useRef(false);
  const requestRef = useRef(request),
    refreshRef = useRef(refresh);
  requestRef.current = request;
  refreshRef.current = refresh;
  const invalidateRequests = useCallback(() => {
    generation.current++;
  }, []);
  const read = useCallback(
    async (signal) => {
      const version = generation.current;
      if (mutating.current) return;
      try {
        const result = await requestRef.current(
          "/tool-installations",
          "GET",
          undefined,
          signal,
        );
        if (mounted.current && version === generation.current && !mutating.current) {
          const found = result.installations?.find((item) => item.tool === tool);
          if (found?.status === "running") observedRunning.current = true;
          setJob(found || null);
          setGlobalBusy(Boolean(result.busy));
          setLoading(false);
          setLoadError(found ? "" : copy.installationUnavailable);
        }
      } catch (err) {
        // A deadline abort reports the timeout; hiding or stopping stays silent.
        if (
          mounted.current &&
          version === generation.current &&
          (!signal?.aborted || timedOut(signal))
        ) {
          setLoadError(timedOut(signal) ? apiCopy.timedOut : err.message);
          setLoading(false);
        }
      }
    },
    [tool],
  );
  // One read on mount and whenever the tab comes back to view.
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (!document.hidden) void read(controller.signal);
    const visible = () => {
      if (!document.hidden && !polling.current) void read();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      controller.abort();
      mounted.current = false;
      invalidateRequests();
    };
  }, [read, invalidateRequests]);
  const delay = toolPollDelay({ job, busy: globalBusy, submitting });
  polling.current = delay !== null;
  // The loop runs only while a job is active, and never from a hidden tab.
  useEffect(() => {
    if (delay === null) return undefined;
    return startVisiblePolling((signal) => read(signal), delay);
  }, [delay, read]);
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
  const reinstall =
    !update &&
    job?.status === "succeeded" &&
    job.installed === false &&
    !attempted &&
    !observedRunning.current;
  useEffect(() => {
    if (job?.status === "succeeded" && !reinstall) synchronize();
    else setReady(false);
  }, [job?.status, job?.finishedAt, job?.version, reinstall, synchronize]);
  async function install() {
    if (
      mutating.current ||
      !(update ? job?.updateAvailable : job?.available) ||
      globalBusy ||
      job.status === "running" ||
      (!update && job.status === "succeeded" && !reinstall)
    )
      return;
    mutating.current = true;
    generation.current++;
    setSubmitting(true);
    setError("");
    try {
      const result = await requestRef.current(
        `/tools/${tool}/${update ? "update" : "install"}`,
        "POST",
        {},
      );
      if (mounted.current) {
        setAttempted(true);
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
  const succeeded = job?.status === "succeeded" && !reinstall && (!update || attempted);
  const utility = tool === "gh" || job?.utility;
  return {
    loading,
    job,
    running,
    submitting,
    globalBusy,
    succeeded,
    reinstall,
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
