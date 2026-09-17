import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import api from "../../lib/api.js";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";

export default function SshProjectReassign({
  sourceProjects,
  targetProjects,
  close,
  reassigned,
}) {
  const [from, setFrom] = useState(sourceProjects[0]?.id || "");
  const [to, setTo] = useState(
    targetProjects.find((project) => project.id !== from)?.id || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={projectCopy.reassignTitle} close={close} closeDisabled={busy}>
      <form
        className="ssh-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!from || !to || from === to || busy) return;
          setBusy(true);
          setError("");
          try {
            await api("/ssh-projects/reassign", "POST", {
              fromProjectId: from,
              toProjectId: to,
            });
            reassigned();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>{projectCopy.reassignHint}</p>
        <fieldset disabled={busy}>
          <label>
            {projectCopy.from}
            <select value={from} onChange={(event) => setFrom(event.target.value)}>
              {sourceProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {projectCopy.to}
            <select value={to} onChange={(event) => setTo(event.target.value)}>
              {targetProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">{copy.busy}</p>}
        <div className="ssh-actions">
          <button type="button" className="button" disabled={busy} onClick={close}>
            {copy.cancel}
          </button>
          <button
            className="button primary"
            disabled={busy || !from || !to || from === to}
          >
            {projectCopy.reassign}
          </button>
        </div>
      </form>
    </Modal>
  );
}
