import React, { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { sessionReloadCopy as copy } from "../../lib/i18n/messages/sessions.js";
import useSessionReload from "./useSessionReload.js";
import "./session-reload.css";

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
  return (
    <Modal title={switchAccount ? copy.switchTitle : copy.title} close={close}>
      <div className="session-reload-dialog">
        <p>{switchAccount ? copy.switchHint : copy.hint}</p>
        <p>{copy.terminalHint}</p>
        <button className="button" onClick={openTerminal}>
          {copy.openTerminal}
        </button>
        {!data && !error && <p role="status">{copy.loading}</p>}
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">{copy.submitting}</p>}
        {data && (
          <>
            {["waiting", "reloading", "completed", "failed"].includes(data.state) && (
              <p role={data.state === "failed" ? "alert" : "status"}>
                {copy[data.state]}
              </p>
            )}
            {!data.eligible && !active && (
              <p role="status">
                {data.reason === "native-session-unverified"
                  ? copy.unverified
                  : copy.unsupported}
              </p>
            )}
            {data.eligible && !active && !reload.pending && (
              <>
                {switchAccount && (
                  <label>
                    {copy.targetAccount}
                    <select
                      aria-label={copy.targetAccount}
                      value={targetAccountId}
                      onChange={(event) => setTargetAccountId(event.target.value)}
                      disabled={busy}
                    >
                      <option value="">{copy.chooseAccount}</option>
                      {(data.accountTargets || []).map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                    {!data.accountTargets?.length && <span>{copy.noAccounts}</span>}
                  </label>
                )}
                {needsInterrupt && (
                  <>
                    <p>{copy.uncertain}</p>
                    <label className="session-reload-acknowledgement">
                      <input
                        type="checkbox"
                        checked={interrupt}
                        onChange={(event) => setInterrupt(event.target.checked)}
                        disabled={busy}
                      />
                      <span>{copy.interrupt}</span>
                    </label>
                  </>
                )}
                {switchAccount &&
                  data.state === "failed" &&
                  (!data.targetAccountId || data.targetAccountId === data.accountId) && (
                    <button
                      className="button primary"
                      disabled={busy || (needsInterrupt && !interrupt)}
                      onClick={() => reload.submit("now", interrupt)}
                    >
                      {copy.retryCurrent}
                    </button>
                  )}
                <div className="session-reload-actions">
                  <button
                    className="button primary"
                    disabled={busy || !validTarget || (needsInterrupt && !interrupt)}
                    onClick={() =>
                      reload.submit(
                        "now",
                        interrupt,
                        switchAccount ? targetAccountId : undefined,
                      )
                    }
                  >
                    {switchAccount ? copy.switchNow : copy.now}
                  </button>
                  <button
                    className="button"
                    disabled={busy || !validTarget}
                    onClick={() =>
                      reload.submit(
                        "when-idle",
                        false,
                        switchAccount ? targetAccountId : undefined,
                      )
                    }
                  >
                    {copy.queue}
                  </button>
                </div>
              </>
            )}
            {data.state === "waiting" && (
              <button className="button" disabled={busy} onClick={reload.cancel}>
                {copy.cancel}
              </button>
            )}
          </>
        )}
        {reload.pending && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => reload.submit()}
          >
            {copy.retry}
          </button>
        )}
        {!data && error && (
          <button className="button" onClick={reload.refresh}>
            {copy.refresh}
          </button>
        )}
        <button className="button" onClick={close}>
          {copy.close}
        </button>
      </div>
    </Modal>
  );
}
