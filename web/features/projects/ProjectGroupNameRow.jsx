import React, { useId, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectGroupsCopy as copy } from "../../lib/i18n/messages/project-groups.js";

/**
 * The inline group-name field of the projects list (new group, later rename): text
 * field, primary submit button and ✕. Enter submits, Escape cancels. `validate(name)`
 * returns a message for a name to refuse; a rejected `onSubmit` shows its message.
 */
export default function ProjectGroupNameRow({
  initialName = "",
  submitLabel,
  validate,
  onSubmit,
  onCancel,
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const problem = validate(name);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await onSubmit(name.trim());
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  };
  return (
    <form
      className="project-group-name-row"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="project-group-name-fields">
        <input
          type="text"
          value={name}
          maxLength={60}
          autoFocus
          placeholder={copy.groupName}
          aria-label={copy.groupName}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
        <button type="submit" className="button primary" disabled={busy}>
          {submitLabel}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={commonCopy.cancel}
          onClick={onCancel}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {error && (
        <p className="project-group-name-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
