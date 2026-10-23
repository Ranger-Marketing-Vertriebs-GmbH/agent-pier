import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { assistantRestartCopy as copy } from "../../lib/i18n/messages/assistant-restart.js";
import { assistantApi } from "./assistant-api.js";
import useAssistants from "./useAssistants.js";

const labels = (codes, names) =>
  [...new Set((codes || []).map((code) => names[code] || names.unavailable))]
    .filter(Boolean)
    .join(", ");

/**
 * The Gateway restart that saved changes still wait for (pending-restart.js): what
 * it is for, what it waits for, and "Restart now" after the owner confirms. Shown
 * where a change could need the restart; nothing while none is pending.
 */
export default function PendingRestartNotice({ className = "" }) {
  const { runtime, refresh } = useAssistants();
  const pending = runtime?.pendingRestart;
  const [confirming, setConfirming] = useState(false);
  if (!pending) return null;
  const reasons = labels(pending.reasons, copy.reason);
  const waiting = labels(pending.waitingFor, copy.waitingFor);
  const sub = pending.running
    ? copy.running
    : [
        copy.description,
        reasons && copy.reasons(reasons),
        pending.failed && copy.failed,
        waiting && copy.waiting(waiting),
      ]
        .filter(Boolean)
        .join(" ");
  const restart = async () => {
    await assistantApi.restartPending();
    await refresh?.();
    setConfirming(false);
  };
  return (
    <ListCard label={copy.title} className={["pending-restart", className].join(" ")}>
      <ListRow label={copy.title} sub={sub} />
      <ListRow
        label={copy.restartNow}
        sub={copy.restartNowDescription}
        disabled={pending.running}
        onClick={pending.running ? undefined : () => setConfirming(true)}
      />
      {confirming && (
        <ConfirmDialog
          title={copy.confirmTitle}
          body={copy.confirmBody}
          confirmLabel={copy.restartNow}
          focusCancel
          onConfirm={restart}
          onCancel={() => setConfirming(false)}
        >
          <p className="assistant-note">
            {copy.affected(
              (pending.affected?.agents || []).map((agent) => agent.name).join(", "),
              pending.affected?.teamMembers,
            )}
          </p>
        </ConfirmDialog>
      )}
    </ListCard>
  );
}
