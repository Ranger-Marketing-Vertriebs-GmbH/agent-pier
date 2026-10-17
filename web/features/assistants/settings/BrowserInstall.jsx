import React, { useEffect, useRef, useState } from "react";
import ListRow from "../../../components/ListRow.jsx";
import Sheet from "../../../components/Sheet.jsx";
import api from "../../../lib/api.js";
import { serverText } from "../../../lib/server-messages.js";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantApi } from "../assistant-api.js";

/**
 * Installs AgentPier's own agent browser (Chrome for Testing, chromium-installer.js)
 * when no separate browser app is there, with its progress, and offers the restart
 * the agent service needs before agents drive a newly installed browser.
 */
export default function BrowserInstall({ browser, refresh }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const alive = useRef(true);
  const running = job?.status === "running";
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(async () => {
      try {
        const list = await api("/tool-installations");
        const found = list.installations?.find((item) => item.tool === "chromium");
        if (!alive.current || !found) return;
        setJob(found);
        if (found.status !== "running") await refresh?.();
      } catch {
        /* The next poll retries. */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [running, refresh]);
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
      {error && (
        <p role="alert" className="assistant-notice">
          {error}
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
              {assistantShellCopy.cancel}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
