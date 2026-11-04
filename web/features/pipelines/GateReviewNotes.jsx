import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatNumber } from "../../lib/i18n/index.js";

/** The ids of the lines GateReviewNotes shows for `check`, for `aria-describedby`. */
export const reviewNotesIds = (check, id) =>
  [check.open > 0 && `${id}-notes`, !check.fits && `${id}-size`]
    .filter(Boolean)
    .join(" ") || undefined;

/**
 * Under a gate's feedback field: how many open review notes go with the feedback, and,
 * while feedback and notes exceed the server's limit, why the feedback actions wait.
 * `check` is useRunReview's check of the typed text.
 */
export default function GateReviewNotes({ check, id }) {
  return (
    <>
      {check.open > 0 && (
        <p id={`${id}-notes`} className="field-description">
          {copy.reviewNotesSent(check.open)}
        </p>
      )}
      {!check.fits && (
        <p id={`${id}-size`} className="field-description" role="status">
          {copy.reviewTooLarge(formatNumber(check.bytes))}
        </p>
      )}
    </>
  );
}
