import React, { useState } from "react";
import api from "../../lib/api.js";
import Modal from "../../components/Modal.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
/** A key's form in a dialog; `bare` renders the form alone (in a side panel). */
export default function SshKeyForm({
  sshKey,
  projects,
  projectId,
  close,
  saved,
  bare = false,
}) {
  const [name, setName] = useState(sshKey?.name || "");
  const [mode, setMode] = useState("generate");
  const [privateKey, setPrivateKey] = useState("");
  const [owner, setOwner] = useState(projectId || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const form = (
    <form
      className="ssh-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !name.trim()) return;
        setBusy(true);
        setError("");
        try {
          const result = await api(
            sshKey ? `/ssh-keys/${encodeURIComponent(sshKey.id)}` : "/ssh-keys",
            sshKey ? "PATCH" : "POST",
            {
              name,
              ...(!sshKey ? { projectId: owner || null } : {}),
              ...(!sshKey && mode === "import" ? { privateKey } : {}),
            },
          );
          setPrivateKey("");
          saved(result);
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        <label>
          {copy.name}
          <input
            required
            maxLength={253}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {sshKey ? (
          <p>{copy.renameKeyHint}</p>
        ) : (
          <>
            <label>
              {projectCopy.owner}
              <select value={owner} onChange={(event) => setOwner(event.target.value)}>
                <option value="">{projectCopy.global}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {copy.keyMode}
              <select
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value);
                  setPrivateKey("");
                }}
              >
                <option value="generate">{copy.generate}</option>
                <option value="import">{copy.import}</option>
              </select>
            </label>
            {mode === "import" && (
              <label>
                {copy.privateKey}
                <textarea
                  required
                  autoComplete="off"
                  spellCheck={false}
                  rows={5}
                  value={privateKey}
                  onChange={(event) => setPrivateKey(event.target.value)}
                />
              </label>
            )}
            <p>{copy.keyHint}</p>
          </>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{copy.busy}</p>}
      <div className="ssh-actions">
        {!bare && (
          <button className="button" type="button" disabled={busy} onClick={close}>
            {commonCopy.cancel}
          </button>
        )}
        <button className="button primary" disabled={busy || !name.trim()}>
          {commonCopy.save}
        </button>
      </div>
    </form>
  );
  if (bare) return form;
  return (
    <Modal
      title={sshKey ? copy.edit : copy.addKey}
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
    >
      {form}
    </Modal>
  );
}
