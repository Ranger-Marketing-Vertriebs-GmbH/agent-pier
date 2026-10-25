import React, { useId, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { secretsCopy as copy } from "../../lib/i18n/messages/secrets.js";

/**
 * A label, its control and an optional hint. The label points at the control so its
 * name stays the label alone (a wrapped select would add its selected option).
 */
function Field({ label, hint, children }) {
  const id = useId();
  return (
    <div className="secret-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": hint ? `${id}-hint` : undefined })}
      {hint && (
        <small id={`${id}-hint`} className="field-description">
          {hint}
        </small>
      )}
    </div>
  );
}

/**
 * One secret's detail. A saved value is never fetched: an existing secret shows
 * "Value saved", and only Replace value reveals an empty field whose content is sent.
 */
export default function SecretForm({ secret, projects, saved, removed }) {
  const [draft, setDraft] = useState({
    name: secret?.name || "",
    description: secret?.description || "",
    projectId: secret?.projectId || "",
  });
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(!secret);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const change = (field) => (event) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        projectId: draft.projectId || null,
        ...(replacing ? { value } : {}),
      };
      const result = secret
        ? await api(`/secrets/${encodeURIComponent(secret.id)}`, "PATCH", body)
        : await api("/secrets", "POST", body);
      setValue("");
      setReplacing(false);
      saved(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="secret-detail">
      <h2>{secret ? secret.name : copy.add}</h2>
      <form className="secret-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          <Field label={copy.name} hint={copy.nameHint}>
            {(field) => (
              <input
                required
                maxLength={64}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                {...field}
                value={draft.name}
                onChange={change("name")}
              />
            )}
          </Field>
          <Field label={copy.description}>
            {(field) => (
              <input
                {...field}
                maxLength={200}
                autoComplete="off"
                value={draft.description}
                onChange={change("description")}
              />
            )}
          </Field>
          <Field label={copy.project} hint={copy.projectHint}>
            {(field) => (
              <select {...field} value={draft.projectId} onChange={change("projectId")}>
                <option value="">{copy.global}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {replacing ? (
            <Field label={copy.value} hint={copy.valueHint}>
              {(field) => (
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  {...field}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </Field>
          ) : (
            <div className="secret-value">
              <span>{copy.value}</span>
              <p>{copy.valueSaved}</p>
              <button
                type="button"
                className="button secondary compact"
                onClick={() => setReplacing(true)}
              >
                {copy.replaceValue}
              </button>
            </div>
          )}
        </fieldset>
        <ErrorMessage error={error} />
        {busy && <p role="status">{copy.saving}</p>}
        <div className="secret-actions">
          {secret && (
            <button
              type="button"
              className="button destructive"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {commonCopy.delete}
            </button>
          )}
          <button type="submit" className="button primary" disabled={busy}>
            {commonCopy.save}
          </button>
        </div>
      </form>
      {confirming && (
        <ConfirmDialog
          destructive
          title={copy.deleteTitle(secret.name)}
          body={copy.deleteBody}
          confirmLabel={commonCopy.delete}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await api(`/secrets/${encodeURIComponent(secret.id)}`, "DELETE");
            setConfirming(false);
            removed(secret.id);
          }}
        />
      )}
    </article>
  );
}
