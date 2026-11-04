import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatNumber } from "../../lib/i18n/index.js";
import "./gate-review-notes.css";

/** The ids of the lines GateReviewNotes shows for `check`, for `aria-describedby`. */
export const reviewNotesIds = (check, id) =>
  [check.open > 0 && `${id}-notes`, !check.fits && `${id}-size`]
    .filter(Boolean)
    .join(" ") || undefined;

/**
 * Under a gate's feedback field: how many open comments go with the feedback, and,
 * while feedback and notes exceed the server's limit, why the feedback actions wait (a
 * warning in a live region that stays mounted, so the notice is announced when it
 * appears). `check` is useRunReview's check of the typed text.
 */
export default function GateReviewNotes({ check, id }) {
  return (
    <>
      {check.open > 0 && (
        <p id={`${id}-notes`} className="field-description">
          {copy.reviewNotesSent(check.open)}
        </p>
      )}
      <p id={`${id}-size`} className="field-description gate-review-size" role="status">
        {check.fits ? "" : copy.reviewTooLarge(formatNumber(check.bytes))}
      </p>
    </>
  );
}
