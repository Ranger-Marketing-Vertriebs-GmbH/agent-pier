import React, { useState } from "react";
import api from "../../lib/api.js";
import Modal from "../../components/Modal.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
export default function SshAccessForm({ access, close, saved }) {
  const [draft, setDraft] = useState({
    name: access?.name || "",
    host: access?.host || "",
    port: access?.port || 22,
    username: access?.username || "",
  });
  const [keyMode, setKeyMode] = useState("generate"),
    [privateKey, setPrivateKey] = useState("");
  const [hostKey, setHostKey] = useState(access?.hostKey || ""),
    [fingerprint, setFingerprint] = useState(access?.hostFingerprint || ""),
    [confirmed, setConfirmed] = useState(Boolean(access));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    if (["host", "port", "username"].includes(field)) {
      setHostKey("");
      setFingerprint("");
      setConfirmed(false);
    }
  };
  const run = async (fn) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={access ? copy.edit : copy.add}
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
    >
      <form
        className="ssh-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!hostKey || !confirmed || busy) return;
          run(async () => {
            const result = await api(
              access ? `/ssh-accesses/${encodeURIComponent(access.id)}` : "/ssh-accesses",
              access ? "PATCH" : "POST",
              {
                ...draft,
                port: Number(draft.port),
                hostKey,
                ...(!access && keyMode === "import" ? { privateKey } : {}),
              },
            );
            setPrivateKey("");
            saved(result);
          });
        }}
      >
        <fieldset disabled={busy}>
          {["name", "host", "port", "username"].map((field) => (
            <label key={field}>
              {copy[field]}
              <input
                required
                type={field === "port" ? "number" : "text"}
                min={field === "port" ? 1 : undefined}
                max={field === "port" ? 65535 : undefined}
                maxLength={field === "port" ? undefined : 253}
                value={draft[field]}
                onChange={(event) => change(field, event.target.value)}
              />
            </label>
          ))}
          {!access && (
            <>
              <label>
                {copy.keyMode}
                <select
                  value={keyMode}
                  onChange={(event) => {
                    setKeyMode(event.target.value);
                    setPrivateKey("");
                  }}
                >
                  <option value="generate">{copy.generate}</option>
                  <option value="import">{copy.import}</option>
                </select>
              </label>
              {keyMode === "import" && (
                <label>
                  {copy.privateKey}
                  <textarea
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={privateKey}
                    onChange={(event) => setPrivateKey(event.target.value)}
                    rows={5}
                  />
                </label>
              )}
              <p>{copy.keyHint}</p>
            </>
          )}
          <button
            className="button"
            type="button"
            disabled={!draft.host || !draft.port}
            onClick={() =>
              run(async () => {
                setHostKey("");
                setFingerprint("");
                setConfirmed(false);
                const result = await api("/ssh-accesses/scan", "POST", {
                  host: draft.host,
                  port: Number(draft.port),
                });
                setHostKey(result.hostKey);
                setFingerprint(result.hostFingerprint);
              })
            }
          >
            {copy.scan}
          </button>
          {fingerprint && (
            <>
              <p>{copy.fingerprint}</p>
              <code className="ssh-fingerprint">{fingerprint}</code>
              <p>{copy.verifyHint}</p>
              <label className="ssh-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>{copy.confirmed}</span>
              </label>
            </>
          )}
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">{copy.busy}</p>}
        <div className="ssh-actions">
          <button className="button" type="button" disabled={busy} onClick={close}>
            {copy.cancel}
          </button>
          <button className="button primary" disabled={busy || !hostKey || !confirmed}>
            {copy.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
