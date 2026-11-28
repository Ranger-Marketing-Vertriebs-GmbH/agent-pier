import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import LearnMore from "../../components/LearnMore.jsx";
import { grantDialogClass } from "../../components/GrantPicker.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { devicesCopy } from "../../lib/i18n/messages/devices.js";
import DeviceGrantFields from "./DeviceGrantFields.jsx";
import {
  accessBlocked,
  accessDraft,
  prunedDraft,
  sameAccess,
} from "./session-device-access.js";
import useSessionDevices from "./useSessionDevices.js";

/**
 * A running coding session's Android devices: which ones it may use, per device
 * whether it may reset and delete it, and whether it may create devices. Saved with
 * PUT and kept while the session exists. A device the session created shows as its
 * own, ticked and fixed. The dialog follows `session.devices:<id>` while open: a
 * pushed value replaces the choices only while they are unchanged, otherwise it keeps
 * them (minus devices that are gone), as SessionAgentAccessDialog does.
 */
export default function SessionDevicesDialog({ session, close }) {
  const { access: copy } = devicesCopy;
  const { data, error: loadError, refresh, save } = useSessionDevices(session.id);
  const [draft, setDraft] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  // The saved access the draft started from: a push moves the draft along only while
  // the owner has not changed anything.
  const base = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!data) return;
    const stored = accessDraft(data);
    // Read now: the updater below may run after `base` already holds the new value.
    const before = base.current;
    setDraft((current) =>
      current === null || (before && sameAccess(current, before))
        ? stored
        : prunedDraft(current, data.devices),
    );
    base.current = stored;
  }, [data]);
  const blocked = data ? accessBlocked(data) : "";
  const offered = Boolean(data && draft && !blocked);
  const submit = async () => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const stored = accessDraft(await save(prunedDraft(draft, data.devices)));
      if (mounted.current) {
        base.current = stored;
        setDraft(stored);
        setSaved(true);
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Modal
      title={copy.title}
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
      className={`session-devices-dialog ${grantDialogClass}`}
      footer={
        offered ? (
          <>
            {error ? (
              <p className="dialog-actions-note error" role="alert">
                {error}
              </p>
            ) : (
              (busy || saved) && (
                <p className="dialog-actions-note" role="status">
                  {busy ? copy.busy : copy.saved}
                </p>
              )
            )}
            <button className="button primary" disabled={busy} onClick={submit}>
              {commonCopy.save}
            </button>
          </>
        ) : null
      }
    >
      <LearnMore hint={copy.summary}>
        <p>{copy.hint}</p>
        <p>{copy.scope}</p>
      </LearnMore>
      {!data && !loadError && <p role="status">{devicesCopy.loading}</p>}
      {!data && loadError && (
        <div className="dialog-status-action">
          <p className="dialog-status dialog-status-error" role="alert">
            {loadError}
          </p>
          <button className="button secondary" onClick={() => refresh()}>
            {commonCopy.retry}
          </button>
        </div>
      )}
      {blocked && (
        <p className="dialog-status dialog-status-warning" role="status">
          {blocked}
        </p>
      )}
      {offered && (
        <>
          <p
            className={`dialog-status dialog-status-${data.tools === "ready" ? "ok" : "warning"}`}
            role="status"
            data-device-tools={data.tools === "ready" ? "ready" : "missing"}
          >
            {copy.tools[data.tools === "ready" ? "ready" : "missing"]}
          </p>
          <DeviceGrantFields
            devices={data.devices}
            draft={draft}
            disabled={busy}
            autoFocus
            onChange={(next) => {
              setSaved(false);
              setDraft(next);
            }}
          />
        </>
      )}
    </Modal>
  );
}
