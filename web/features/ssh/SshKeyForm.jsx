import React, { useState } from "react";
import api from "../../lib/api.js";
import Modal from "../../components/Modal.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
export default function SshKeyForm({ sshKey, close, saved }) {
  const [name, setName] = useState(sshKey?.name || "");
  const [mode, setMode] = useState("generate");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={sshKey ? copy.edit : copy.addKey}
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
    >
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
              { name, ...(!sshKey && mode === "import" ? { privateKey } : {}) },
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
          <button className="button" type="button" disabled={busy} onClick={close}>
            {copy.cancel}
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {copy.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
