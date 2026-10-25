import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import LearnMore from "../../components/LearnMore.jsx";
import Icon from "../../components/Icon.jsx";
import api from "../../lib/api.js";
import useSshAccesses from "./useSshAccesses.js";
import SshChoices from "./SshChoices.jsx";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import "./ssh.css";
import { connectionsRoute, connectionsRoutePath } from "../connections/routes.js";
const toolTones = {
  ready: "ok",
  starting: "pending",
  "reload-required": "warning",
  unavailable: "neutral",
};
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

  const save = async () => {
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
  };
  const state = tools?.state || "unavailable";

  return (
    <Modal
      title={copy.title}
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
      className="ssh-dialog"
      footer={
        data ? (
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
            <button className="button primary" disabled={busy} onClick={save}>
              {commonCopy.save}
            </button>
          </>
        ) : null
      }
    >
      <LearnMore hint={copy.sessionSummary}>
        <p>{copy.sessionHint}</p>
        <p>{copy.scope}</p>
        <p>{copy.revokeHint}</p>
      </LearnMore>
      {!data && !loadError && <p role="status">{copy.loading}</p>}
      {loadError && (
        <div className="dialog-status-action">
          <p className="dialog-status dialog-status-error" role="alert">
            {loadError}
          </p>
          <button className="button secondary" onClick={reload}>
            {commonCopy.retry}
          </button>
        </div>
      )}
      {data && (
        <>
          <div className="dialog-status-action">
            <p
              className={`dialog-status dialog-status-${toolTones[state]}`}
              role="status"
            >
              {
                {
                  ready: copy.toolsReady,
                  starting: copy.toolsStarting,
                  "reload-required": copy.toolsReload,
                  unavailable: copy.toolsUnavailable,
                }[state]
              }
            </p>
            {state === "reload-required" && openReload && (
              <button
                className="button secondary"
                disabled={busy || dirty}
                onClick={openReload}
              >
                {copy.reload}
              </button>
            )}
          </div>
          {state === "reload-required" && openReload && dirty && (
            <p className="dialog-hint" role="status">
              {copy.unsaved}
            </p>
          )}
          <SshChoices
            accesses={data.accesses}
            selected={selected}
            inherited={data.inheritedIds || []}
            disabled={busy}
            hideLegend
            change={(ids) => {
              setSelected(ids);
              setSaved(false);
            }}
          />
          {data.commands.length > 0 && (
            <details className="learn-more">
              <summary>
                {copy.advanced}
                <Icon name="down" size={14} />
              </summary>
              <div className="learn-more-body">
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
              </div>
            </details>
          )}
        </>
      )}
      <a
        className="ssh-dialog-manage"
        href={connectionsRoutePath(connectionsRoute("ssh"))}
      >
        {data?.inheritedIds?.length ? projectCopy.manageProject : copy.manage}
      </a>
    </Modal>
  );
}
