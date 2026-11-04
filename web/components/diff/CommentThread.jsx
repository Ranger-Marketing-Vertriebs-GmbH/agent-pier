import React, { useState } from "react";
import ChatMarkdown from "../ChatMarkdown.jsx";
import ErrorMessage from "../ErrorMessage.jsx";
import StatusChip from "../StatusChip.jsx";
import { useAlertDialogFocus } from "../useAlertDialogFocus.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { diffReviewCopy as copy } from "../../lib/i18n/messages/diff-review.js";
import CommentEditor from "./CommentEditor.jsx";
import DiffRows from "./DiffRows.jsx";
import "./diff-review.css";

function DeleteConfirm({ onCancel, onConfirm }) {
  const { ref, onKeyDown } = useAlertDialogFocus(onCancel);
  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-label={copy.deleteQuestion}
      className="diff-thread-confirm"
      onKeyDown={onKeyDown}
    >
      <p>{copy.deleteQuestion}</p>
      <div className="diff-comment-actions">
        <button
          type="button"
          className="button secondary"
          data-autofocus
          onClick={onCancel}
        >
          {commonCopy.cancel}
        </button>
        <button type="button" className="button danger" onClick={onConfirm}>
          {copy.deleteNow}
        </button>
      </div>
    </div>
  );
}

const firstLine = (body) => body.trim().split("\n", 1)[0];

// One comment: open with its body and actions, resolved as one collapsed line, and
// with the stored excerpt when its line is gone (outdated).
export default function CommentThread({
  comment,
  outdated = false,
  readOnly = false,
  language,
  onUpdate,
  onDelete,
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (write) => {
    setBusy(true);
    setError("");
    try {
      await write();
    } catch (failure) {
      setError(failure?.message || String(failure));
    } finally {
      setBusy(false);
    }
  };
  const resolved = comment.status === "resolved";
  const marks = (
    <>
      {outdated && <StatusChip tone="neutral">{copy.outdated}</StatusChip>}
      {Number.isInteger(comment.sentIn) && (
        <small className="diff-thread-sent">{copy.sentIn(comment.sentIn)}</small>
      )}
    </>
  );
  if (resolved) {
    return (
      <div className="diff-thread is-resolved">
        <span className="diff-thread-summary">{firstLine(comment.body)}</span>
        {marks}
        {!readOnly && (
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => run(() => onUpdate(comment.id, { status: "open" }))}
          >
            {copy.reopen}
          </button>
        )}
        <ErrorMessage error={error} />
      </div>
    );
  }
  const excerpt = outdated ? comment.anchor?.excerpt : null;
  return (
    <div className="diff-thread">
      {(outdated || Number.isInteger(comment.sentIn)) && (
        <div className="diff-thread-marks">{marks}</div>
      )}
      {Array.isArray(excerpt) && excerpt.length > 0 && (
        <div className="diff-scroll diff-thread-excerpt">
          <div className="diff-lines">
            <DiffRows rows={excerpt} language={language} />
          </div>
        </div>
      )}
      {editing ? (
        <CommentEditor
          initial={comment.body}
          label={copy.editorLabel}
          onSave={async (body) => {
            await onUpdate(comment.id, { body });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="diff-thread-body">
          <ChatMarkdown>{comment.body}</ChatMarkdown>
        </div>
      )}
      {!readOnly && !editing && !confirming && (
        <div className="diff-comment-actions">
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            {commonCopy.edit}
          </button>
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => run(() => onUpdate(comment.id, { status: "resolved" }))}
          >
            {copy.resolve}
          </button>
          <button
            type="button"
            className="button destructive compact"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {commonCopy.delete}
          </button>
        </div>
      )}
      {confirming && (
        <DeleteConfirm
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            run(() => onDelete(comment.id));
          }}
        />
      )}
      <ErrorMessage error={error} />
    </div>
  );
}
