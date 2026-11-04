import React, { useId, useState } from "react";
import ErrorMessage from "../ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { diffReviewCopy as copy } from "../../lib/i18n/messages/diff-review.js";
import { MAX_COMMENT_BYTES, editorKey, editorState } from "./diff-review-state.js";
import "./diff-review.css";

// A Markdown comment field with Save and Cancel; ⌘/Ctrl+Enter saves, Escape cancels.
// `onChange` hears each edit, so a parent can keep the draft across a remount; a
// parent that keeps the save itself across a remount passes it as `saving`.
export default function CommentEditor({
  initial = "",
  label,
  onChange,
  onSave,
  onCancel,
  saving = false,
}) {
  const [text, setText] = useState(initial);
  const [ownBusy, setBusy] = useState(false);
  const busy = saving || ownBusy;
  const [error, setError] = useState("");
  const id = useId();
  const state = editorState(text);
  const save = async () => {
    if (!state.canSave || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave(text);
    } catch (failure) {
      setError(failure?.message || String(failure));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event) => {
    const action = editorKey(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "save") save();
    else if (!busy) onCancel();
  };
  return (
    <div className="diff-comment-editor">
      <label htmlFor={`${id}-body`}>{label}</label>
      <textarea
        id={`${id}-body`}
        value={text}
        rows={4}
        autoFocus
        disabled={busy}
        aria-describedby={state.nearLimit ? `${id}-count` : undefined}
        aria-invalid={state.tooLong || undefined}
        onChange={(event) => {
          setText(event.target.value);
          onChange?.(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {state.nearLimit && (
        <small
          id={`${id}-count`}
          className={state.tooLong ? "diff-comment-count error" : "diff-comment-count"}
        >
          {commonCopy.ofCount(state.bytes, MAX_COMMENT_BYTES)}
          {state.tooLong && <> · {copy.tooLong}</>}
        </small>
      )}
      <ErrorMessage error={error} />
      <div className="diff-comment-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {commonCopy.cancel}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!state.canSave || busy}
          onClick={save}
        >
          {busy ? commonCopy.saving : commonCopy.save}
        </button>
      </div>
    </div>
  );
}
