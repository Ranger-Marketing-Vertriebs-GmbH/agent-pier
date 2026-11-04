import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { diffReviewCopy as copy } from "../../lib/i18n/messages/diff-review.js";
import CommentEditor from "./CommentEditor.jsx";
import CommentThread from "./CommentThread.jsx";
import DiffRows from "./DiffRows.jsx";
import {
  ROW_PAGE,
  commentInput,
  commentTarget,
  fileCommentLayout,
  initialSelection,
  rowLine,
  rowsChanged,
  selectRow,
  selectionAction,
  selectionKey,
} from "./diff-review-state.js";
import "./diff-review.css";

const statusLabel = (status) =>
  copy[`status${status[0].toUpperCase()}${status.slice(1)}`] ?? status;

function selection(state, action) {
  if (action.type === "key") return selectionKey(state, action.key, action.rows) ?? state;
  if (action.type === "select") return selectRow(state, action.index, action.rows);
  if (action.type === "rows") return rowsChanged(state, action.rows);
  return selectionAction(state, action.type, action.target);
}

// One file of a review: heading, rows in pages of ROW_PAGE, threads after their row,
// then the comments whose row is not shown yet and the outdated ones.
export default function DiffFile({
  file,
  workspace = "",
  placement,
  language,
  readOnly = false,
  onCreate,
  onUpdate,
  onDelete,
  id,
}) {
  const [limit, setLimit] = useState(ROW_PAGE);
  const [state, dispatch] = useReducer(selection, initialSelection);
  const region = useRef(null);
  // The draft's text and its save in flight survive the editor moving to another row
  // after a refresh (a remount), so a second Save cannot create the comment twice.
  const draft = useRef("");
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => file.rows.slice(0, limit), [file.rows, limit]);
  const shownRows = useRef(file.rows);
  const layout = useMemo(
    () => fileCommentLayout(placement, file.rows, rows.length),
    [placement, file.rows, rows.length],
  );
  const editable = !readOnly && typeof onCreate === "function";
  const remaining = file.rows.length - rows.length;

  useEffect(() => {
    if (state.selected === null) return;
    region.current
      ?.querySelectorAll(":scope > .diff-lines > .diff-row")
      [state.selected]?.scrollIntoView?.({ block: "nearest" });
  }, [state.selected]);

  useEffect(() => {
    if (shownRows.current === file.rows) return;
    shownRows.current = file.rows;
    dispatch({ type: "rows", rows });
  }, [file.rows, rows]);

  const close = () => {
    draft.current = "";
    dispatch({ type: "close" });
    region.current?.focus({ preventScroll: true });
  };
  const thread = (comment, outdated = false) => (
    <CommentThread
      key={comment.id}
      comment={comment}
      outdated={outdated}
      readOnly={readOnly}
      language={language}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />
  );
  const editor = state.editing && (
    <CommentEditor
      initial={draft.current}
      label={copy.editorLabel}
      saving={busy}
      onChange={(text) => (draft.current = text)}
      onSave={async (body) => {
        if (saving.current) return;
        saving.current = true;
        setBusy(true);
        try {
          await onCreate(commentInput(state.target, body));
          close();
        } finally {
          saving.current = false;
          setBusy(false);
        }
      }}
      onCancel={close}
    />
  );
  const renderAfter = (index) => {
    const threads = layout.after.get(index);
    const action = editable && state.selected === index && state.open;
    if (!threads && !action) return null;
    return (
      <div className="diff-row-after">
        {threads?.map((comment) => thread(comment))}
        {action &&
          (state.editing ? (
            editor
          ) : (
            <button
              type="button"
              className="button secondary diff-comment-button"
              onClick={() =>
                dispatch({
                  type: "edit",
                  target: commentTarget({ workspace, file, index }),
                })
              }
            >
              {copy.comment(rowLine(rows[index]))}
            </button>
          ))}
      </div>
    );
  };

  return (
    <section className="diff-file" id={id}>
      <h3 className="diff-file-heading">
        <span className="diff-file-path">
          {file.oldPath && <>{file.oldPath} → </>}
          {file.path}
        </span>
        <span className="diff-file-meta">
          <span>{statusLabel(file.status)}</span>
          <span className="diff-file-count">
            +{file.added} −{file.removed}
          </span>
        </span>
      </h3>
      {file.binary ? (
        <p className="diff-file-note">{copy.binary}</p>
      ) : file.rows.length === 0 ? (
        <p className="diff-file-note">{copy.noRows}</p>
      ) : (
        <div
          ref={region}
          className={`diff-scroll diff-review-scroll${editable ? " is-editable" : ""}`}
          role="region"
          tabIndex={0}
          aria-label={copy.diffOf(file.path)}
          onKeyDown={
            editable
              ? (event) => {
                  if (event.target !== event.currentTarget) return;
                  const next = selectionKey(state, event.key, rows);
                  if (!next) return;
                  event.preventDefault();
                  dispatch({ type: "key", key: event.key, rows });
                }
              : undefined
          }
        >
          <div className="diff-lines">
            <DiffRows
              rows={rows}
              language={language}
              selected={editable ? state.selected : null}
              onSelect={
                editable
                  ? (index) => dispatch({ type: "select", index, rows })
                  : undefined
              }
              renderAfter={renderAfter}
            />
          </div>
        </div>
      )}
      {state.editing && state.selected === null && (
        <div className="diff-file-draft">
          <small className="diff-file-comment-line">{copy.line(state.target.line)}</small>
          {editor}
        </div>
      )}
      {remaining > 0 && (
        <button
          type="button"
          className="button secondary compact diff-file-more"
          onClick={() => setLimit(limit + ROW_PAGE)}
        >
          {copy.moreRows(Math.min(ROW_PAGE, remaining))}
        </button>
      )}
      {file.rowsTruncated && (
        <p className="diff-file-note">{copy.rowsCapped(file.rows.length)}</p>
      )}
      {(layout.hidden.length > 0 || layout.outdated.length > 0) && (
        <ul className="diff-file-comments">
          {layout.hidden.map(({ comment, line }) => (
            <li key={comment.id}>
              <small className="diff-file-comment-line">
                {copy.line(line)} · {copy.expandHint}
              </small>
              {thread(comment)}
            </li>
          ))}
          {layout.outdated.map((comment) => (
            <li key={comment.id}>
              <small className="diff-file-comment-line">{copy.line(comment.line)}</small>
              {thread(comment, true)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
