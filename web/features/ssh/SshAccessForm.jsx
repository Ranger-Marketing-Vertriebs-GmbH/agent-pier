import React, { useId, useRef, useState } from "react";
import api from "../../lib/api.js";
import Modal from "../../components/Modal.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import Segmented from "../../components/Segmented.jsx";
import Switch from "../../components/Switch.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import SftpCredentialFields from "./SftpCredentialFields.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
/**
 * The SSH/SFTP access form: a dialog for a new access (and Edit in the list), or
 * `inline` in an access's full view, where it keeps a draft with the save bar and asks
 * before a navigation leaves unsaved changes (`saveNote` names who they affect).
 */
export default function SshAccessForm({
  access,
  keys,
  projects,
  projectId,
  close,
  saved,
  inline = false,
  saveNote,
}) {
  const [owner, setOwner] = useState(access?.projectId || projectId || "");
  const ownedKeys = keys.filter((key) => (key.projectId || "") === owner);
  const initial = () => ({
    name: access?.name || "",
    // A deleted key is no choice: Save waits until a valid key is selected.
    keyId: access?.keyMissing ? "" : access?.keyId || ownedKeys[0]?.id || "",
    host: access?.host || "",
    port: access?.port || 22,
    username: access?.username || "",
    type: access?.type || "ssh",
    auth: access?.auth || "password",
    password: "",
    remoteRoot: access?.remoteRoot || "",
    legacyAlgorithms: access?.legacyAlgorithms === true,
    interactiveShell: access?.interactiveShell === true,
  });
  const [base] = useState(initial);
  const [draft, setDraft] = useState(base);
  const legacyHint = useId(),
    interactiveHint = useId();
  const sftp = draft.type === "sftp",
    usesKey = !sftp || draft.auth === "key",
    hasPassword = Boolean(access?.hasPassword) && draft.auth === "password";
  // A password is needed on a new host and when switching a key host to a password.
  const passwordRequired = sftp && draft.auth === "password" && !hasPassword;
  const [hostKey, setHostKey] = useState(access?.hostKey || ""),
    [fingerprint, setFingerprint] = useState(access?.hostFingerprint || ""),
    [confirmed, setConfirmed] = useState(Boolean(access));
  const ready =
    hostKey &&
    confirmed &&
    !(usesKey && !draft.keyId) &&
    !(passwordRequired && !draft.password);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const formRef = useRef(null);
  const changed = [
    ...Object.keys(base).filter(
      (field) => JSON.stringify(draft[field]) !== JSON.stringify(base[field]),
    ),
    ...(hostKey !== (access?.hostKey || "") ? ["hostKey"] : []),
  ];
  const dirty = inline && changed.length > 0;
  const reset = () => {
    setDraft(base);
    setHostKey(access?.hostKey || "");
    setFingerprint(access?.hostFingerprint || "");
    setConfirmed(Boolean(access));
    setError("");
  };
  const change = (field, value) => {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "auth" && value === "key" ? { password: "" } : {}),
    }));
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
      return { status: "saved" };
    } catch (err) {
      setError(err.message);
      return { status: "failed" };
    } finally {
      setBusy(false);
    }
  };
  const keySelect = (
    <label>
      {copy.keyMode}
      <select
        required
        value={draft.keyId}
        onChange={(event) => change("keyId", event.target.value)}
      >
        <option value="" disabled>
          {copy.selectKey}
        </option>
        {ownedKeys.map((key) => (
          <option key={key.id} value={key.id}>
            {key.name}
          </option>
        ))}
      </select>
      {access?.keyMissing && !draft.keyId && (
        <small className="ssh-action-hint">{copy.keyMissing}</small>
      )}
    </label>
  );
  const submit = () => {
    if (!ready || busy) return Promise.resolve({ status: "blocked" });
    const {
      type,
      auth,
      password,
      remoteRoot,
      keyId,
      legacyAlgorithms,
      interactiveShell,
      ...fields
    } = draft;
    const body = !sftp
      ? { ...fields, keyId, legacyAlgorithms, interactiveShell }
      : {
          ...fields,
          auth,
          remoteRoot,
          ...(access ? {} : { type }),
          ...(auth === "key" ? { keyId } : {}),
          ...(auth === "password" && password ? { password } : {}),
        };
    return run(async () => {
      const result = await api(
        access ? `/ssh-accesses/${encodeURIComponent(access.id)}` : "/ssh-accesses",
        access ? "PATCH" : "POST",
        {
          ...body,
          port: Number(draft.port),
          hostKey,
          ...(!access ? { projectId: owner || null } : {}),
        },
      );
      saved(result);
    });
  };
  const sheet = useUnsavedChangesGuard({
    draft: { dirty, changeCount: changed.length, confirmation: null, reset },
    tab: access?.name || copy.add,
    save: submit,
    stays: () => false,
  });
  const form = (
    <form
      ref={formRef}
      className="ssh-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={busy}>
        {!access && (
          <label>
            {projectCopy.owner}
            <select
              value={owner}
              onChange={(event) => {
                const value = event.target.value;
                setOwner(value);
                setDraft((current) => ({
                  ...current,
                  keyId: keys.find((key) => (key.projectId || "") === value)?.id || "",
                }));
              }}
            >
              <option value="">{projectCopy.global}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ssh-field">
          <span>{copy.type}</span>
          <Segmented
            label={copy.type}
            value={draft.type}
            disabled={Boolean(access)}
            onChange={(value) => change("type", value)}
            options={[
              { value: "ssh", label: copy.typeSsh },
              { value: "sftp", label: copy.typeSftp },
            ]}
          />
        </div>
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
        {sftp ? (
          <SftpCredentialFields
            draft={draft}
            change={change}
            hasPassword={hasPassword}
            passwordRequired={passwordRequired}
            keySelect={keySelect}
          />
        ) : (
          <>
            {keySelect}
            <div className="ssh-field">
              <Switch
                label={copy.legacyAlgorithms}
                checked={draft.legacyAlgorithms}
                onChange={(value) => change("legacyAlgorithms", value)}
                aria-describedby={legacyHint}
              />
              <small id={legacyHint} className="ssh-legacy-warning">
                {copy.legacyAlgorithmsHint}
              </small>
            </div>
            <div className="ssh-field">
              <Switch
                label={copy.interactiveShell}
                checked={draft.interactiveShell}
                onChange={(value) => change("interactiveShell", value)}
                aria-describedby={interactiveHint}
              />
              <small id={interactiveHint} className="ssh-action-hint">
                {copy.interactiveShellHint}
              </small>
            </div>
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
      {!inline && (
        <div className="ssh-actions">
          <button className="button" type="button" disabled={busy} onClick={close}>
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={busy || !ready}>
            {commonCopy.save}
          </button>
        </div>
      )}
    </form>
  );
  if (inline)
    return (
      <>
        {form}
        <SaveBar
          draft={{
            dirty,
            saving: busy,
            outcome: null,
            conflicts: [],
            reset,
            reload: reset,
          }}
          onSave={() => formRef.current?.requestSubmit()}
          note={saveNote}
          saveDisabled={!ready}
        />
        <UnsavedChangesSheet {...sheet} />
      </>
    );
  return (
    <Modal
      title={access ? copy.edit : copy.add}
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
    >
      {form}
    </Modal>
  );
}
