import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import api from "../../lib/api.js";
import useSshAccesses from "./useSshAccesses.js";
import SshChoices from "./SshChoices.jsx";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import "./ssh.css";
export default function SessionSshDialog({ session, close, openReload }) {
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
  const dirty =
    data &&
    (selected.length !== data.assignedIds.length ||
      selected.some((id) => !data.assignedIds.includes(id)));
  const [tools, setTools] = useState(null);
  useEffect(() => {
    if (data) setTools(data.tools);
  }, [data]);
  useEffect(() => {
    if (tools?.state !== "starting") return;
    const controller = new AbortController();
    let timer;
    async function poll() {
      try {
        const result = await api(path, "GET", undefined, controller.signal);
        if (!controller.signal.aborted) {
          setTools(result.tools);
          if (result.tools?.state === "starting") timer = setTimeout(poll, 1500);
        }
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
      }
    }
    timer = setTimeout(poll, 1500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, tools?.state]);

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
            <p role="status">
              {
                {
                  ready: copy.toolsReady,
                  starting: copy.toolsStarting,
                  "reload-required": copy.toolsReload,
                  unavailable: copy.toolsUnavailable,
                }[tools?.state || "unavailable"]
              }
            </p>
            {tools?.state === "reload-required" && openReload && (
              <>
                {dirty && <p role="status">{copy.unsaved}</p>}
                <button className="button" disabled={busy || dirty} onClick={openReload}>
                  {copy.reload}
                </button>
              </>
            )}
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
              <details>
                <summary>{copy.advanced}</summary>
                <p>
                  {copy.commandHint} <code>-- uname -a</code>
                </p>
                {data.commands.map((item) => (
                  <SshCopy
                    key={item.id}
                    label={`${copy.command} · ${data.accesses.find((access) => access.id === item.id)?.name || item.id}`}
                    text={item.command}
                    button={copy.copyCommand}
                  />
                ))}
              </details>
            )}
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
