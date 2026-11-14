import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import LearnMore from "../../components/LearnMore.jsx";
import CheckRow from "../../components/CheckRow.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { sessionTalkCopy } from "../../lib/i18n/messages/session-talk.js";
import useAgentAccesses from "./useAgentAccesses.js";

const copy = sessionTalkCopy.dialog;
const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * A running coding session's Agent access: the owner's agents it may talk to. An agent
 * granted through the session's project is ticked and fixed ("via project"); the rest
 * are this session's own grant, saved with PUT and ended when the session stops. The
 * dialog follows `session.agent-access:<id>` while open: a pushed value replaces the
 * choices only while they are unsaved-free, otherwise it keeps them (minus agents that
 * left the list), as SessionSshDialog does with its topic.
 */
export default function SessionAgentAccessDialog({ session, close }) {
  const { data, error: loadError, refresh, save } = useAgentAccesses(session.id);
  const [selected, setSelected] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  // The saved grant the choices started from: a push moves them along only while the
  // owner has not changed anything.
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
    const listed = new Set(data.agents.map((agent) => agent.id));
    setSelected((current) =>
      current === null || (base.current && sameIds(current, base.current))
        ? data.assignedIds
        : current.filter((id) => listed.has(id)),
    );
    base.current = data.assignedIds;
  }, [data]);
  const choices = selected || [];
  const inherited = data?.inheritedIds || [];
  const submit = async () => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await save(choices);
      if (mounted.current) {
        base.current = result.assignedIds;
        setSelected(result.assignedIds);
        setSaved(true);
      }
    } catch (err) {
      if (mounted.current) setError(err.message);
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
      className="session-agent-access-dialog"
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
            <button className="button primary" disabled={busy} onClick={submit}>
              {commonCopy.save}
            </button>
          </>
        ) : null
      }
    >
      <LearnMore hint={copy.summary}>
        <p>{copy.hint}</p>
        <p>{copy.projectHint}</p>
      </LearnMore>
      {!data && !loadError && <p role="status">{copy.loading}</p>}
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
      {data && (
        <>
          <p role="status" data-agent-tools={data.tools}>
            <StatusChip tone={data.tools === "ready" ? "ok" : "neutral"}>
              {copy.tools[data.tools === "ready" ? "ready" : "missing"]}
            </StatusChip>
          </p>
          <fieldset className="check-list" disabled={busy}>
            <legend className="visually-hidden">{copy.title}</legend>
            {!data.agents.length && <p className="dialog-hint">{copy.empty}</p>}
            {data.agents.map((agent) => {
              const managed = inherited.includes(agent.id);
              return (
                <CheckRow
                  key={agent.id}
                  title={agent.name}
                  checked={managed || choices.includes(agent.id)}
                  disabled={busy || managed}
                  onChange={(event) => {
                    setSaved(false);
                    setSelected(
                      event.target.checked
                        ? [...choices, agent.id]
                        : choices.filter((id) => id !== agent.id),
                    );
                  }}
                >
                  {managed && <span className="check-row-meta">{copy.viaProject}</span>}
                </CheckRow>
              );
            })}
          </fieldset>
        </>
      )}
    </Modal>
  );
}
