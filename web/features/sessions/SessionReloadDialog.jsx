import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import { sessionReloadCopy as copy } from "../../lib/i18n/messages/sessions.js";
import useSessionReload from "./useSessionReload.js";
import "./session-reload.css";

export default function SessionReloadDialog({ session, close, pending }) {
  const reload = useSessionReload(session, pending);
  const [interrupt, setInterrupt] = useState(false);
  const { data, busy, error } = reload;
  const active = ["waiting", "reloading"].includes(data?.state);
  const needsInterrupt =
    data && !["idle", "stopped"].includes(data.activity?.state ?? data.activity);
  return (
    <Modal title={copy.title} close={close}>
      <div className="session-reload-dialog">
        <p>{copy.hint}</p>
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
                <div className="session-reload-actions">
                  <button
                    className="button primary"
                    disabled={busy || (needsInterrupt && !interrupt)}
                    onClick={() => reload.submit("now", interrupt)}
                  >
                    {copy.now}
                  </button>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => reload.submit("when-idle")}
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
