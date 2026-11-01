import React, { useEffect, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import { PANE_HINT_FROM } from "./split-tree.js";

/**
 * The view's name (activate it to rename in place), the pane count from five panes
 * on, and Delete view behind a confirmation.
 */
export default function ViewHeader({ view, paneCount, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(view.name);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const field = useRef(null);
  const saving = useRef(false);
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);
  const start = () => {
    setName(view.name);
    setError("");
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError("");
  };
  const save = async () => {
    if (saving.current) return;
    if (name === view.name) return cancel();
    saving.current = true;
    try {
      await onRename(name);
      setEditing(false);
      setError("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      saving.current = false;
    }
  };
  return (
    <header className="view-header">
      {editing ? (
        <div className="view-header-name-field">
          <input
            ref={field}
            aria-label={viewsCopy.nameLabel}
            value={name}
            maxLength={60}
            aria-invalid={error ? "true" : undefined}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
            onBlur={() => {
              if (!error) save();
            }}
          />
          <ErrorMessage error={error} />
        </div>
      ) : (
        <h1>
          <button
            type="button"
            className="view-header-name"
            title={viewsCopy.rename}
            onClick={start}
          >
            {view.name}
          </button>
        </h1>
      )}
      {paneCount >= PANE_HINT_FROM && (
        <span className="view-header-hint">{viewsCopy.paneHint(paneCount)}</span>
      )}
      <button
        type="button"
        className="icon-button view-header-delete"
        aria-label={viewsCopy.deleteView}
        title={viewsCopy.deleteView}
        onClick={() => setConfirming(true)}
      >
        <Icon name="trash" />
      </button>
      {confirming && (
        <ConfirmDialog
          title={viewsCopy.deleteView}
          body={viewsCopy.deleteBody(view.name)}
          confirmLabel={viewsCopy.deleteView}
          destructive
          onConfirm={onDelete}
          onCancel={() => setConfirming(false)}
        />
      )}
    </header>
  );
}
