import React, { useEffect, useRef, useState } from "react";
import ListRow from "../../../components/ListRow.jsx";
import Sheet from "../../../components/Sheet.jsx";
import api from "../../../lib/api.js";
import { serverText } from "../../../lib/server-messages.js";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import { assistantApi } from "../assistant-api.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";

/**
 * Installs AgentPier's own agent browser (Chrome for Testing, chromium-installer.js)
 * when no separate browser app is there, with its progress, and offers the restart
 * the agent service needs before agents drive a newly installed browser.
 */
export default function BrowserInstall({ browser, refresh }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const running = job?.status === "running";
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // While its job runs, the installation follows the live `job.tool:chromium` topic:
  // each progress step is pushed, and its end reads the browser state once. A topic
  // switched on again first shows what it held from the previous job, so only the
  // entry of the job this install started (its `startedAt`) counts.
  const progress = useLiveTopic(running ? "job.tool:chromium" : null);
  const found = progress.data?.installations?.find((item) => item.tool === "chromium");
  const pushed = found && found.startedAt === job?.startedAt ? found : null;
  useEffect(() => {
    if (!pushed) return;
    setJob(pushed);
    if (pushed.status !== "running") void refreshRef.current?.();
  }, [pushed]);
  // A read the channel could not push (its fallback, a timeout) shows while it runs.
  const shownError = error || (running ? progress.error : "");
  const install = async () => {
    setError("");
    try {
      setJob(await api("/tools/chromium/install", "POST", {}));
    } catch (err) {
      setError(err.message);
    }
  };
  const restart = async () => {
    setConfirming(false);
    setError("");
    try {
      await assistantApi.operate("restart");
      await refresh?.();
    } catch (err) {
      setError(err.message);
    }
  };
  const missing =
    browser?.visible?.available === false && browser.visible.reason === "noApp";
  const offered =
    (missing && browser?.installable) || running || job?.status === "failed";
  return (
    <>
      {offered && (
        <ListRow
          label={copy.install}
          sub={
            job?.message && job.status !== "idle"
              ? serverText(job.message)
              : copy.installDescription
          }
          disabled={running}
          onClick={running ? undefined : install}
        />
      )}
      {browser?.restartNeeded && (
        <ListRow
          label={copy.restart}
          sub={copy.restartDescription}
          onClick={() => setConfirming(true)}
        />
      )}
      {shownError && (
        <p role="alert" className="assistant-notice">
          {shownError}
        </p>
      )}
      {confirming && (
        <Sheet
          open
          title={copy.restartTitle}
          onCancel={() => setConfirming(false)}
          className="agent-confirmation-sheet"
        >
          <div className="sheet-body">
            <p>{copy.restartDescription}</p>
          </div>
          <div className="sheet-actions">
            <button type="button" className="button primary" onClick={restart}>
              {copy.restartConfirm}
            </button>
            <button
              type="button"
              className="button secondary"
              autoFocus
              onClick={() => setConfirming(false)}
            >
              {commonCopy.cancel}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
