import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import api from "../../lib/api.js";
import useSshAccesses from "./useSshAccesses.js";
import SshChoices from "./SshChoices.jsx";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import "./ssh.css";
export default function SessionSshDialog({ session, close }) {
  const path = `/sessions/${encodeURIComponent(session.id)}/ssh-accesses`;
  const { data, setData, error: loadError, reload } = useSshAccesses(path);
  const [selected, setSelected] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (data) setSelected(data.assignedIds);
  }, [data]);
  return (
    <Modal
      title={copy.title}
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
    >
      <div className="ssh-dialog">
        <p>{copy.sessionHint}</p>
        <p>{copy.scope}</p>
        <p>{copy.revokeHint}</p>
        {!data && !loadError && <p role="status">{copy.loading}</p>}
        {loadError && (
          <div>
            <p role="alert">{loadError}</p>
            <button className="button" onClick={reload}>
              {copy.retry}
            </button>
          </div>
        )}
        {data && (
          <>
            <SshChoices
              accesses={data.accesses}
              selected={selected}
              disabled={busy}
              change={(ids) => {
                setSelected(ids);
                setSaved(false);
              }}
            />
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setSaved(false);
                try {
                  const result = await api(path, "PUT", { accessIds: selected });
                  if (mounted.current) {
                    setData(result);
                    setSaved(true);
                  }
                } catch (err) {
                  if (mounted.current) setError(err.message);
                } finally {
                  if (mounted.current) setBusy(false);
                }
              }}
            >
              {copy.save}
            </button>
            {data.commands.length > 0 && (
              <p>
                {copy.commandHint} <code>-- uname -a</code>
              </p>
            )}
            {data.commands.map((item) => (
              <SshCopy
                key={item.id}
                label={`${copy.command} · ${data.accesses.find((access) => access.id === item.id)?.name || item.id}`}
                text={item.command}
                button={copy.copyCommand}
              />
            ))}
          </>
        )}
        {busy && <p role="status">{copy.busy}</p>}
        {saved && <p role="status">{copy.saved}</p>}
        {error && <p role="alert">{error}</p>}
        <a href="/settings/ssh">{copy.manage}</a>
      </div>
    </Modal>
  );
}
