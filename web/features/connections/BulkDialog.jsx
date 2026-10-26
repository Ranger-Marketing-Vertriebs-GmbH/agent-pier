import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { runSummary } from "./bulk-run.js";

/** One line per item of a finished bulk action: done, or failed with the reason. */
export function BulkResults({ results }) {
  const { ok, failed } = runSummary(results);
  return (
    <div className="connections-bulk-results">
      <p role="status">{copy.bulk.summary(ok, failed)}</p>
      <ul aria-label={copy.bulk.resultsTitle}>
        {results.map((result, index) => (
          <li key={`${result.label}-${index}`} className={result.ok ? "ok" : "failed"}>
            <StatusDot tone={result.ok ? "ok" : "error"} />
            <span className="connections-bulk-result-name">{result.label}</span>
            <span>
              {result.ok
                ? result.detail || copy.bulk.resultOk
                : copy.bulk.resultFailed(result.error?.message || String(result.error))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A bulk action's dialog: the choice (children), then the run with its progress and
 * one result per item. `run(onProgress)` resolves `[{ label, ok, error?, detail? }]`;
 * failed items are listed, never repeated silently. `onDone` hears the end of a run
 * (to reload lists) whether or not something failed.
 */
export default function BulkDialog({
  title,
  intro,
  children,
  confirmLabel,
  confirmDisabled = false,
  destructive = false,
  autoStart = false,
  run,
  close,
  onDone,
}) {
  const [phase, setPhase] = useState(autoStart ? "running" : "choose");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState(null);
  const start = async () => {
    setPhase("running");
    const finished = await run((done, total) => setProgress({ done, total }));
    setResults(finished);
    setPhase("done");
    onDone?.(finished);
  };
  // A bulk test needs no choice and starts with the dialog, once.
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);
  const running = phase === "running";
  return (
    <Modal
      title={title}
      close={() => {
        if (!running) close();
      }}
      closeDisabled={running}
      className="connections-bulk-dialog"
      footer={
        phase === "choose" ? (
          <>
            <button type="button" className="button secondary" onClick={close}>
              {commonCopy.cancel}
            </button>
            <button
              type="button"
              className={`button ${destructive ? "danger" : "primary"}`}
              disabled={confirmDisabled}
              onClick={start}
            >
              {confirmLabel}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button secondary"
            disabled={running}
            onClick={close}
          >
            {copy.bulk.close}
          </button>
        )
      }
    >
      {intro &&
        (Array.isArray(intro) ? intro : [intro]).map((text) => <p key={text}>{text}</p>)}
      {phase === "choose" && children}
      {running && (
        <p role="status" className="connections-bulk-progress">
          {copy.bulk.progress(progress.done, progress.total)}
          <progress max={progress.total || 1} value={progress.done} />
        </p>
      )}
      {phase === "done" && results && <BulkResults results={results} />}
    </Modal>
  );
}
