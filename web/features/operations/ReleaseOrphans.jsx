import React, { useState } from "react";
import api from "../../lib/api.js";
import ConfirmOperation from "./ConfirmOperation.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

/**
 * Orphaned processes of an old version: they only run its Node, without an AgentPier
 * script, and lost their parent. They never block deleting it; the owner may stop
 * them after confirming.
 */
export default function ReleaseOrphans({ version, processes, busy, onStopped }) {
  const [confirm, setConfirm] = useState(false),
    [stopped, setStopped] = useState(0);
  if (!processes?.length) return null;
  return (
    <div className="release-orphans">
      <p>
        <strong>{copy.orphanedTitle(processes.length)}</strong>
      </p>
      <p className="field-description">{copy.orphanedHelp}</p>
      <ul aria-label={copy.orphanedTitle(processes.length)}>
        {processes.map((item) => (
          <li key={item.pid}>
            <code>
              {item.pid} {item.command}
            </code>
          </li>
        ))}
      </ul>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => setConfirm(true)}
      >
        {copy.orphanedStop}
      </button>
      {stopped > 0 && <p role="status">{copy.orphanedStopped(stopped)}</p>}
      {confirm && (
        <ConfirmOperation
          description={copy.orphanedConfirm(version, processes.length)}
          close={() => setConfirm(false)}
          action={async () => {
            const result = await api(
              `/operations/releases/cleanup/${encodeURIComponent(version)}/stop-processes`,
              "POST",
              { pids: processes.map((item) => item.pid) },
            );
            setConfirm(false);
            setStopped(result.stopped.length);
            onStopped?.();
          }}
        />
      )}
    </div>
  );
}
