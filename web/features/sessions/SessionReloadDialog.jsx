import React, { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import CheckRow from "../../components/CheckRow.jsx";
import Icon from "../../components/Icon.jsx";
import LearnMore from "../../components/LearnMore.jsx";
import { sessionReloadCopy as copy } from "../../lib/i18n/messages/sessions.js";
import useSessionReload from "./useSessionReload.js";
import { routeLabel } from "../provider-connections/route-label.js";
import "./session-reload.css";

const stateTones = {
  waiting: "pending",
  reloading: "pending",
  completed: "ok",
  failed: "error",
};

export default function SessionReloadDialog({
  session,
  close,
  pending,
  openTerminal,
  switchAccount = false,
}) {
  const reload = useSessionReload(session, pending);
  const [interrupt, setInterrupt] = useState(false);
  const [targetAccountId, setTargetAccountId] = useState("");
  const { data, busy, error } = reload;
  useEffect(() => {
    if (!busy && data?.state === "reloading") openTerminal();
  }, [busy, data?.state, openTerminal]);
  const validTarget =
    !switchAccount || data?.accountTargets?.some((a) => a.id === targetAccountId);
  const active = ["waiting", "reloading"].includes(data?.state);
  const needsInterrupt =
    data && !["idle", "stopped"].includes(data.activity?.state ?? data.activity);
  const choosing = data?.eligible && !active && !reload.pending;
  const target = switchAccount ? targetAccountId : undefined;
  const actions = [
    choosing &&
      switchAccount &&
      data.state === "failed" &&
      (!data.targetAccountId || data.targetAccountId === data.accountId) && (
        <button
          key="retry-current"
          className="button secondary"
          disabled={busy || (needsInterrupt && !interrupt)}
          onClick={() => reload.submit("now", interrupt)}
        >
          {copy.retryCurrent}
        </button>
      ),
    choosing && (
      <button
        key="queue"
        className="button secondary"
        disabled={busy || !validTarget}
        onClick={() => reload.submit("when-idle", false, target)}
      >
        {copy.queue}
      </button>
    ),
    choosing && (
      <button
        key="now"
        className="button primary"
        disabled={busy || !validTarget || (needsInterrupt && !interrupt)}
        onClick={() => reload.submit("now", interrupt, target)}
      >
        {switchAccount ? copy.switchNow : copy.now}
      </button>
    ),
    data?.state === "waiting" && (
      <button
        key="cancel"
        className="button secondary"
        disabled={busy}
        onClick={reload.cancel}
      >
        {copy.cancel}
      </button>
    ),
    reload.pending && (
      <button
        key="retry"
        className="button primary"
        disabled={busy}
        onClick={() => reload.submit()}
      >
        {copy.retry}
      </button>
    ),
    !data && error && (
      <button key="refresh" className="button secondary" onClick={reload.refresh}>
        {copy.refresh}
      </button>
    ),
  ].filter(Boolean);
  return (
    <Modal
      title={switchAccount ? copy.switchTitle : copy.title}
      close={close}
      className="session-reload-dialog"
      footer={actions.length ? actions : null}
    >
      <LearnMore hint={switchAccount ? copy.switchSummary : copy.hint}>
        {switchAccount && <p>{copy.switchDetails}</p>}
        <p>{copy.terminalHint}</p>
      </LearnMore>
      {!data && !error && <p role="status">{copy.loading}</p>}
      {error && (
        <p className="dialog-status dialog-status-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="dialog-status dialog-status-pending" role="status">
          {copy.submitting}
        </p>
      )}
      {/* Present from the first render, so filling it is announced. */}
      <div className="session-reload-route" role="status">
        {data?.routeChange && (
          <p className="dialog-status dialog-status-warning">
            {data.routeChange.to
              ? copy.routeChanged(
                  routeLabel(data.routeChange.from),
                  routeLabel(data.routeChange.to),
                )
              : copy.routeUnavailable(routeLabel(data.routeChange.from))}
          </p>
        )}
      </div>
      {data && ["waiting", "reloading", "completed", "failed"].includes(data.state) && (
        <p
          className={`dialog-status dialog-status-${stateTones[data.state]}`}
          role={data.state === "failed" ? "alert" : "status"}
        >
          {copy[data.state]}
        </p>
      )}
      {data && !data.eligible && !active && (
        <p className="dialog-status" role="status">
          {data.reason === "native-session-unverified"
            ? copy.unverified
            : copy.unsupported}
        </p>
      )}
      {choosing && switchAccount && (
        <label>
          {copy.targetAccount}
          <select
            aria-label={copy.targetAccount}
            value={targetAccountId}
            onChange={(event) => setTargetAccountId(event.target.value)}
            disabled={busy}
          >
            <option value="" data-placeholder="">
              {copy.chooseAccount}
            </option>
            {(data.accountTargets || []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          {!data.accountTargets?.length && (
            <span className="dialog-hint">{copy.noAccounts}</span>
          )}
        </label>
      )}
      {choosing && needsInterrupt && (
        <>
          <p className="dialog-hint">{copy.uncertain}</p>
          <CheckRow
            title={copy.interrupt}
            checked={interrupt}
            onChange={(event) => setInterrupt(event.target.checked)}
            disabled={busy}
          />
        </>
      )}
      <button className="button secondary session-reload-terminal" onClick={openTerminal}>
        <Icon name="terminal" size={16} />
        {copy.openTerminal}
      </button>
    </Modal>
  );
}
