import React, { useState } from "react";
import useRunAction from "./useRunAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { runTitle } from "./run-title.js";
import GateReviewNotes, { reviewNotesIds } from "./GateReviewNotes.jsx";
import useRunReview from "./useRunReview.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import {
  confirmDescription,
  confirmedActions,
  destructiveActions,
  feedbackActions,
  primaryActions,
  localCommitsBlockDelete,
  offeredRunActions,
  requestRunAction,
} from "./run-action-request.js";

// Renders the engine-authorized run actions in server order; `exclude` hides actions
// another control (the gate decision block) already offers. An optional `shared` action
// runner lets several action areas of one run disable each other while one is pending.
// Feedback actions carry the run's open review notes, as in GateDecision.
export default function RunActions({ run, refresh, removed, exclude = [], shared }) {
  const [feedback, setFeedback] = useState(""),
    [resumeAt, setResumeAt] = useState(""),
    [confirm, setConfirm] = useState(null);
  const mutation = useRunAction(shared);
  const actions = offeredRunActions(run).filter(
    (action) => copy.actions[action] && !exclude.includes(action),
  );
  const offersFeedback = actions.some((action) => feedbackActions.includes(action));
  const review = useRunReview(run, offersFeedback);
  const check = review.check(feedback);
  const notesId = `run-review-notes-${run.id}`;
  const execute = async (action) => {
    let deleted;
    try {
      deleted = await requestRunAction(
        run,
        action === "delete-local" ? "delete" : action,
        {
          feedback,
          review: true,
          resumeAt,
          confirmLocalCommits: action === "delete-local",
        },
      );
    } catch (error) {
      // Local-only commits ask once more; confirming removes the worktree and keeps
      // the run branch.
      if (action === "delete" && localCommitsBlockDelete(error)) {
        setConfirm("delete-local");
        return;
      }
      throw error;
    }
    if (deleted) {
      removed();
      return;
    }
    setConfirm(null);
    setFeedback("");
    // Busy until the run's push shows the action's result (useLiveTopic written()).
    await refresh();
  };
  if (!actions.length) return null;
  return (
    <section className="pipeline-card pipeline-gate">
      {offersFeedback && (
        <>
          <label>
            {copy.feedback}
            <textarea
              aria-label={copy.feedback}
              aria-describedby={reviewNotesIds(check, notesId)}
              rows={3}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
            />
          </label>
          <GateReviewNotes check={check} id={notesId} />
        </>
      )}
      {actions.includes("wait-for-reset") && (
        <label>
          {copy.resumeAt}
          <input
            type="datetime-local"
            value={resumeAt}
            onChange={(event) => setResumeAt(event.target.value)}
          />
        </label>
      )}
      <div className="pipeline-actions">
        {actions.map((action) => (
          <button
            key={action}
            className={`button ${primaryActions.includes(action) ? "primary" : "secondary"}`}
            disabled={
              mutation.busy ||
              (action === "feedback" && !feedback.trim() && !check.open) ||
              (feedbackActions.includes(action) && !check.fits)
            }
            onClick={() =>
              confirmedActions.includes(action)
                ? setConfirm(action)
                : mutation.run(() => execute(action))
            }
          >
            {copy.actions[action]}
          </button>
        ))}
      </div>
      <ErrorMessage error={mutation.error} />
      {confirm && (
        <ConfirmDialog
          key={confirm}
          destructive={destructiveActions.includes(confirm)}
          title={copy.confirmTitles[confirm](runTitle(run))}
          body={confirmDescription(confirm, run)}
          confirmLabel={
            confirm === "delete-local"
              ? copy.deleteKeepBranch
              : copy.confirmLabels[confirm]
          }
          onCancel={() => setConfirm(null)}
          onConfirm={() => execute(confirm)}
        />
      )}
    </section>
  );
}
