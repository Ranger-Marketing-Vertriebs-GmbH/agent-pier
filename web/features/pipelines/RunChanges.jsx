import React, { useId, useRef, useState } from "react";
import { usePageAction } from "../../app/page-action.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import DiffReview from "../../components/diff/DiffReview.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import useReviewComments from "../review/useReviewComments.js";
import { gateWaits } from "./run-diff-state.js";
import useRunDiff from "./useRunDiff.js";
import "./run-changes.css";

/**
 * The run's whole diff against its base commit, below the spec: closed by default,
 * opened with **Review changes**. Line comments are the run's review comments; they can
 * be written only while a decision that can carry them waits, the run's own or a group
 * member's feedback or a finished run's Return to stage (they go out with it), and
 * only while the worktree exists. An imported history run has
 * no changes on this host and shows nothing. The ⌘K action **Review changes** opens
 * the section of the run on screen.
 */
export default function RunChanges({ run }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const toggle = useRef(null);
  const imported = run.imported?.historyOnly === true;
  usePageAction(
    "run-changes",
    () => {
      setOpen(true);
      toggle.current?.focus();
      toggle.current?.scrollIntoView?.({ block: "nearest" });
    },
    !imported,
  );
  const diff = useRunDiff(run, open && !imported);
  const review = useReviewComments(imported ? null : { kind: "run", id: run.id });
  if (imported || diff.imported) return null;
  const notes = review.comments.filter((comment) => comment.status === "open").length;
  const readOnly = diff.unavailable || !gateWaits(run);
  return (
    <section className="run-changes" aria-label={copy.diff}>
      <div className="run-changes-head">
        <button
          ref={toggle}
          type="button"
          className="button secondary compact"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="run-changes-cue" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          {copy.reviewChanges}
        </button>
        {notes > 0 && (
          <span className="run-changes-notes">{copy.reviewNotes(notes)}</span>
        )}
        {open && !diff.unavailable && (
          <button
            type="button"
            className="button secondary compact"
            disabled={diff.loading}
            onClick={diff.refresh}
          >
            {copy.refreshChanges}
          </button>
        )}
      </div>
      {open && (
        <div id={bodyId} className="run-changes-body">
          <ErrorMessage error={diff.error || review.error} />
          {diff.unavailable ? (
            <p className="run-changes-note">{copy.runDiffUnavailable}</p>
          ) : diff.loaded && !review.loading ? (
            <DiffReview
              files={diff.files}
              comments={review.comments}
              readOnly={readOnly}
              truncated={diff.truncated}
              onCreate={review.create}
              onUpdate={review.update}
              onDelete={review.remove}
              empty={<p className="run-changes-note">{copy.emptyDiff}</p>}
            />
          ) : (
            !diff.error && <p role="status">{copy.changesLoading}</p>
          )}
        </div>
      )}
    </section>
  );
}
