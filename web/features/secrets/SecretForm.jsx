import React, { useEffect, useId, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { sameValue } from "../../lib/settings/draft-state.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
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
export default function SecretForm({ secret, projects, focusHeading, saved, removed }) {
  const base = {
    name: secret?.name || "",
    description: secret?.description || "",
    projectId: secret?.projectId || "",
  };
  const [draft, setDraft] = useState(base);
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(!secret);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const heading = useRef(null);
  const valueInput = useRef(null);
  const replaceButton = useRef(null);
  // The control that replaces the one just clicked, focused once it is rendered.
  const focusNext = useRef(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  useEffect(() => {
    focusNext.current?.current?.focus();
    focusNext.current = null;
  }, [replacing]);
  const change = (field) => (event) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));
  const changed = Object.keys(base).filter((key) => !sameValue(draft[key], base[key]));
  const changeCount = changed.length + (value ? 1 : 0);
  const busyRef = useRef(false);
  const save = async () => {
    if (busyRef.current) return { status: "busy" };
    busyRef.current = true;
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
      return { status: "saved" };
    } catch (err) {
      setError(err.message);
      return { status: "failed" };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const sheet = useUnsavedChangesGuard({
    draft: {
      dirty: changeCount > 0,
      changeCount,
      confirmation: null,
      reset: () => {
        setDraft(base);
        setValue("");
        setReplacing(!secret);
      },
    },
    tab: secret ? secret.name : copy.add,
    save,
    stays: () => false,
  });
  const showReplace = () => {
    focusNext.current = valueInput;
    setReplacing(true);
  };
  const keepValue = () => {
    focusNext.current = replaceButton;
    setValue("");
    setReplacing(false);
  };
  return (
    <article className="secret-detail">
      <h2 ref={heading} tabIndex={-1}>
        {secret ? secret.name : copy.add}
      </h2>
      {/* Controls stay enabled while saving so the focused one keeps its focus;
          a second submit is ignored instead. */}
      <form
        className="secret-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="secret-fields">
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
            <div className="secret-replace">
              <Field label={copy.value} hint={copy.valueHint}>
                {(field) => (
                  <input
                    ref={valueInput}
                    type="password"
                    required
                    // Not a login: keep browsers and password managers from saving it.
                    name="secret-content"
                    autoComplete="new-password"
                    data-1p-ignore
                    data-lpignore="true"
                    {...field}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  />
                )}
              </Field>
              {secret && (
                <button
                  type="button"
                  className="button secondary compact"
                  onClick={keepValue}
                >
                  {copy.keepValue}
                </button>
              )}
            </div>
          ) : (
            <div className="secret-value">
              <span>{copy.value}</span>
              <p>{copy.valueSaved}</p>
              <button
                ref={replaceButton}
                type="button"
                className="button secondary compact"
                onClick={showReplace}
              >
                {copy.replaceValue}
              </button>
            </div>
          )}
        </div>
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
          <button type="submit" className="button primary" aria-disabled={busy}>
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
      <UnsavedChangesSheet {...sheet} />
    </article>
  );
}
