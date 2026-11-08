import React, { useCallback, useId, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { diffReviewCopy as copy } from "../../lib/i18n/messages/diff-review.js";
import { placeComments } from "../../../server/features/changes/review-anchor.js";
import CommentThread from "./CommentThread.jsx";
import DiffFile from "./DiffFile.jsx";
import { openByDefault } from "./diff-review-state.js";
import { fileLanguage } from "./file-language.js";
import "./diff-review.css";

// A diff with line comments: the file list, every file, then the comments on files
// that are no longer in the diff. The caller filters `comments` to `workspace`.
// Files past openByDefault start collapsed to their heading; the files shown open only
// grow while the review is mounted (one workspace or run), and a file the reader
// opens or closes keeps that choice (by path) across refreshes of the diff.
export default function DiffReview({
  files,
  comments = [],
  workspace = "",
  readOnly = false,
  truncated = false,
  onCreate,
  onUpdate,
  onDelete,
  toolbar,
  empty,
}) {
  const prefix = useId();
  const placement = useMemo(() => placeComments(comments, files), [comments, files]);
  const [shown, setShown] = useState(() => openByDefault(files, placement.byFile));
  const grown = openByDefault(files, placement.byFile, shown);
  // a refresh or late comments add to the open files during this render, never close one
  if (grown !== shown) setShown(grown);
  const [chosen, setChosen] = useState(() => new Map());
  const toggle = useCallback(
    (path, value) => setChosen((last) => new Map(last).set(path, value)),
    [],
  );
  const isOpen = (file) => chosen.get(file.path) ?? grown.has(file.path);
  const commentsOn = (path) => {
    const entry = placement.byFile.get(path);
    return entry ? entry.placed.length + entry.outdated.length : 0;
  };
  const collapsed = files.filter((file) => !isOpen(file)).length;
  const open = comments.filter((comment) => comment.status === "open").length;
  const fileId = (index) => `${prefix}-file-${index}`;
  if (files.length === 0 && placement.missing.length === 0 && empty) return empty;
  const jump = (index) => {
    if (!isOpen(files[index])) flushSync(() => toggle(files[index].path, true));
    const target = document.getElementById(fileId(index));
    target?.scrollIntoView({ block: "start" });
    // the diff region, else (a binary or empty file) the heading's toggle
    (
      target?.querySelector(".diff-scroll") ?? target?.querySelector(".diff-file-toggle")
    )?.focus({ preventScroll: true });
  };
  return (
    <div className="diff-review">
      {toolbar}
      <p className="diff-review-summary">
        {copy.files(files.length)}
        {open > 0 && <> · {copy.openComments(open)}</>}
        {collapsed > 0 && <> · {copy.collapsedFiles(collapsed)}</>}
      </p>
      {files.length > 0 && (
        <nav aria-label={copy.changedFiles}>
          <ul className="diff-review-files">
            {files.map((file, index) => (
              <li key={`${file.path}:${index}`}>
                <button
                  type="button"
                  className="diff-review-file-link"
                  onClick={() => jump(index)}
                >
                  <span className="diff-file-path">{file.path}</span>
                  {commentsOn(file.path) > 0 && (
                    <span className="diff-review-file-comments">
                      {copy.comments(commentsOn(file.path))}
                    </span>
                  )}
                  <span className="diff-file-count">
                    +{file.added} −{file.removed}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {truncated && <p className="diff-file-note">{copy.truncated}</p>}
      {files.map((file, index) => (
        <DiffFile
          key={`${file.path}:${index}`}
          id={fileId(index)}
          file={file}
          workspace={workspace}
          placement={placement.byFile.get(file.path)}
          language={fileLanguage(file.path)}
          open={isOpen(file)}
          onToggle={toggle}
          readOnly={readOnly}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
      {placement.missing.length > 0 && (
        <section className="diff-file">
          <h3 className="diff-file-heading">{copy.missingFile}</h3>
          <ul className="diff-file-comments">
            {placement.missing.map((comment) => (
              <li key={comment.id}>
                <small className="diff-file-comment-line">
                  {comment.file} · {copy.line(comment.line)}
                </small>
                <CommentThread
                  comment={comment}
                  outdated
                  readOnly={readOnly}
                  language={fileLanguage(comment.file)}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
