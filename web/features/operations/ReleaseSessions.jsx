import React, { useState } from "react";
import useResource from "../../lib/useResource.js";
import api from "../../lib/api.js";
import ConfirmOperation from "./ConfirmOperation.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

const inFlight = (state) => ["waiting", "reloading"].includes(state);
function stateLabel(session) {
  const states = copy.migrateStates;
  if (!session.eligible && !inFlight(session.reload))
    return states[session.reason] || states.ineligible;
  if (session.reload === "failed")
    return session.reloadError
      ? `${states.failed}: ${session.reloadError}`
      : states.failed;
  if (session.reload === "reloading")
    return session.reloadSince && Date.now() - Date.parse(session.reloadSince) > 30000
      ? states.approval
      : states.reloading;
  if (session.reload === "waiting") return states.queued;
  if (session.activity === "idle") return states.ready;
  if (session.activity === "unknown") return states.unknown;
  return states.busy;
}

export default function ReleaseSessions({
  version,
  busy,
  migrating,
  onMigrate,
  onCancel,
}) {
  const [open, setOpen] = useState(false),
    [confirm, setConfirm] = useState(null),
    [cancelError, setCancelError] = useState("");
  const resource = useResource(
    open ? `/operations/releases/cleanup/${encodeURIComponent(version)}/sessions` : null,
    { poll: 3000 },
  );
  const plan = resource.data;
  // The server knows about a migration started elsewhere (or before a reload).
  const running = Boolean(migrating) || plan?.migrating === true;
  const sessions = plan?.sessions || [];
  const hasBusy = sessions.some(
    (session) =>
      !inFlight(session.reload) && session.eligible && session.activity !== "idle",
  );
  const ineligible = sessions.some((s) => !s.eligible && !inFlight(s.reload));
  return (
    <div>
      <button className="button secondary" onClick={() => setOpen((value) => !value)}>
        {copy.migrateSessions}
      </button>
      {open && (
        <>
          <ErrorMessage error={resource.error} />
          {resource.loading && <p role="status">{copy.migrateLoading}</p>}
          {plan && !sessions.length && <p>{copy.migrateEmpty}</p>}
          {sessions.length > 0 && (
            <ul aria-label={`Sessions: ${version}`}>
              {sessions.map((session) => (
                <li key={session.id}>
                  <strong>{session.name || session.id.slice(0, 8)}</strong> ·{" "}
                  {session.tool} · {stateLabel(session)}
                </li>
              ))}
            </ul>
          )}
          {plan?.nodeOnlyProcesses > 0 && (
            <p className="field-description">
              {copy.migrateNodeOnly(plan.nodeOnlyProcesses)}
            </p>
          )}
          {ineligible && <p>{copy.migrateIneligibleHint}</p>}
          {plan?.unidentifiedProcesses?.length > 0 && (
            <p>
              {copy.migrateUnidentifiedHint(
                plan.unidentifiedProcesses.map((item) => item.reference).join(", "),
              )}
            </p>
          )}
          <div className="operations-actions">
            <button
              className="button primary"
              disabled={busy || !plan?.migratable || running}
              onClick={() => setConfirm("migrate")}
            >
              {copy.migrateStart}
            </button>
            {hasBusy && (
              <button
                className="button secondary"
                disabled={busy || !plan?.migratable || running}
                onClick={() => setConfirm("interrupt")}
              >
                {copy.migrateInterrupt}
              </button>
            )}
            {running && (
              <button
                className="button secondary"
                onClick={async () => {
                  setCancelError("");
                  try {
                    await api(
                      `/operations/releases/cleanup/${encodeURIComponent(version)}/migrate`,
                      "DELETE",
                    );
                    onCancel?.();
                  } catch (error) {
                    setCancelError(error.message);
                  }
                }}
              >
                {copy.migrateCancel}
              </button>
            )}
          </div>
          <ErrorMessage error={cancelError} />
        </>
      )}
      {confirm && (
        <ConfirmOperation
          description={(confirm === "interrupt"
            ? copy.migrateInterruptConfirm
            : copy.migrateConfirm)(version, sessions.length)}
          close={() => setConfirm(null)}
          action={async () => {
            const result = await api(
              `/operations/releases/cleanup/${encodeURIComponent(version)}/migrate`,
              "POST",
              confirm === "interrupt" ? { interrupt: true } : {},
            );
            setConfirm(null);
            onMigrate(result.job.id);
          }}
        />
      )}
    </div>
  );
}
