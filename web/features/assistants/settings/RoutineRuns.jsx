import React, { useState } from "react";
import ActivityRow from "../../../components/ActivityRow.jsx";
import CodeBlock from "../../../components/CodeBlock.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import {
  formatMessageTime,
  formatNumber,
  formatTimestamp,
} from "../../../lib/i18n/index.js";
import { routineCopy as copy } from "../../../lib/i18n/messages/assistant-routines.js";
import { failureText } from "../routine-failure-text.js";
import { routineApi } from "../routine-api.js";

/**
 * A failed run as an activity row: the readable cause, its time, and, opened,
 * OpenClaw's own message (redacted and bounded by the server) to read or copy.
 */
export function RunFailure({ failure, atMs, durationMs, consecutive }) {
  return (
    <ActivityRow
      icon="history"
      className="routine-run-failure"
      data-routine-failure={failure.reason}
      label={failureText(failure)}
      detail={Number.isFinite(atMs) ? formatMessageTime(atMs) : null}
      status={copy.states.failed}
      tone="error"
    >
      {failure.message ? (
        <CodeBlock
          className="activity-row-code"
          aria-label={copy.failureMessage}
          copyText={failure.message}
          copyLabel={copy.copyFailure}
        >
          <code>{failure.message}</code>
        </CodeBlock>
      ) : (
        <p className="activity-row-note">{copy.noFailureMessage}</p>
      )}
      <dl className="activity-row-facts">
        {Number.isFinite(atMs) && (
          <>
            <dt>{copy.runAt}</dt>
            <dd>{formatTimestamp(atMs)}</dd>
          </>
        )}
        {Number.isFinite(durationMs) && (
          <>
            <dt>{copy.duration}</dt>
            <dd>
              {copy.seconds(
                formatNumber(durationMs / 1000, { maximumFractionDigits: 1 }),
              )}
            </dd>
          </>
        )}
      </dl>
      {consecutive > 1 && (
        <p className="activity-row-note">{copy.failedInARow(consecutive)}</p>
      )}
    </ActivityRow>
  );
}

/** A routine's last failure and, on request, its recent runs (newest first). */
export default function RoutineRuns({ assistantId, item, busy }) {
  const [runs, setRuns] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  async function toggle() {
    if (runs) return setRuns(null);
    setLoading(true);
    setError("");
    try {
      const result = await routineApi.runs(assistantId, item.id);
      setRuns([...(result.entries || [])].sort((a, b) => b.runAtMs - a.runAtMs));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  const failure = item.lastFailure;
  return (
    <div className="routine-runs">
      {failure && (
        <RunFailure
          failure={failure}
          atMs={failure.atMs}
          consecutive={failure.consecutive}
        />
      )}
      <div className="assistant-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy || loading}
          aria-expanded={!!runs}
          onClick={toggle}
        >
          {runs ? copy.hideHistory : copy.history}
        </button>
      </div>
      <ErrorMessage error={error} />
      {runs?.length === 0 && <p className="agent-row-note">{copy.noRuns}</p>}
      {runs?.map((run, index) =>
        run.failure ? (
          <RunFailure
            key={`${run.runAtMs}-${index}`}
            failure={run.failure}
            atMs={run.runAtMs}
            durationMs={run.durationMs}
          />
        ) : (
          <p key={`${run.runAtMs}-${index}`} className="agent-row-note">
            {formatTimestamp(run.runAtMs)} ·{" "}
            {run.status === "ok" ? copy.runOk : copy.states.unknown}
          </p>
        ),
      )}
    </div>
  );
}
