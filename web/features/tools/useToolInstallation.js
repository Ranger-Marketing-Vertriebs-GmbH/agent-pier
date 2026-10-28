import { useToolInstallationCopy as copy } from "../../lib/i18n/messages/tools.js";
import { useEffect, useRef, useState, useCallback } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
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
    missed = useRef(false),
    synchronizing = useRef(false),
    observedRunning = useRef(false);
  const requestRef = useRef(request),
    refreshRef = useRef(refresh);
  requestRef.current = request;
  refreshRef.current = refresh;
  // The installation follows the live `job.tool:<tool>` topic: every job write of the
  // installer, a job started elsewhere and the busy flag of another tool's job are
  // pushed, so nothing is polled or read again on focus.
  const resource = useLiveTopic(`job.tool:${tool}`);
  const { data, error: readError, refresh: reread } = resource;
  const apply = useCallback(
    (result) => {
      const found = result.installations?.find((item) => item.tool === tool);
      if (found?.status === "running") observedRunning.current = true;
      setJob(found || null);
      setGlobalBusy(Boolean(result.busy));
      setLoading(false);
      setLoadError(found ? "" : copy.installationUnavailable);
      return found || null;
    },
    [tool],
  );
  useEffect(() => {
    if (!data) return;
    // A start's own answer is newer than a push that arrives while it is sent.
    if (mutating.current) missed.current = true;
    else apply(data);
  }, [data, apply]);
  useEffect(() => {
    if (!readError) return;
    setLoadError(readError);
    setLoading(false);
  }, [readError]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    let conflict = false;
    mutating.current = true;
    missed.current = false;
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
      conflict = err.status === 409;
    } finally {
      if (mounted.current) {
        mutating.current = false;
        setSubmitting(false);
      }
    }
    // Another start won, or the CLI appeared outside AgentPier (no job write tells):
    // show what is there now instead of a stale idle view. A push missed while the
    // start was sent is read the same way.
    if ((conflict || missed.current) && mounted.current) {
      missed.current = false;
      const result = await reread();
      const found = result && mounted.current ? apply(result) : null;
      if (conflict && found?.status === "running") setError("");
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
