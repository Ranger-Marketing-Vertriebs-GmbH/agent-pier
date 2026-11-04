import { useCallback, useMemo } from "react";
import {
  REVIEW_FEEDBACK_LIMIT,
  combineFeedback,
  feedbackBytes,
  formatReviewBatch,
  reviewEntries,
} from "../../../server/features/changes/review-batch.js";
import useReviewComments from "../review/useReviewComments.js";
import useRunDiff from "./useRunDiff.js";

/** @typedef {import("../../../server/features/changes/review-anchor.js").Comment} Comment */
/** @typedef {import("../../../server/features/changes/diff-parse.js").DiffFile} DiffFile */

const isOpen = (comment) => comment.status === "open";

/**
 * The batch of the run's open comments, relocated against the whole-run diff (`files`,
 * null while it is unknown: every comment is then outdated, as the server sends it
 * without a diff); `batch` is null without open comments.
 * @param {Comment[]} comments
 * @param {DiffFile[] | null} files
 */
export function reviewBatch(comments, files) {
  const open = comments.filter(isOpen);
  if (!open.length) return { open: 0, batch: null };
  const located = reviewEntries(open, files ? new Map([["", files]]) : new Map());
  return { open: open.length, batch: formatReviewBatch(located) };
}

/**
 * What a gate's feedback sends with `review: true`: the free text and the `batch` of
 * reviewBatch. The same text and byte count as the server's check (server/features/
 * pipelines/review-feedback.js); without open comments the free text goes as typed.
 * @param {{ open: number, batch: string | null }} review
 * @param {string} freeText
 */
export function checkFeedback({ open, batch }, freeText) {
  const text = batch === null ? (freeText ?? "") : combineFeedback(freeText ?? "", batch);
  const bytes = feedbackBytes(text);
  return { open, text, bytes, fits: bytes <= REVIEW_FEEDBACK_LIMIT };
}

/**
 * reviewBatch and checkFeedback in one step.
 * @param {{ freeText: string, comments: Comment[], files: DiffFile[] | null }} input
 */
export const reviewCheck = ({ freeText, comments, files }) =>
  checkFeedback(reviewBatch(comments, files), freeText);

/**
 * The run's open review comments for a gate form that sends feedback (`enabled`):
 * their count and `check(freeText)`, the size check of what the gate would send. The
 * batch is built once per comment or diff change, not per keystroke; the whole-run
 * diff is read only while open comments exist.
 */
export default function useRunReview(run, enabled = true) {
  const follow = enabled && run?.id && run.imported?.historyOnly !== true;
  const review = useReviewComments(follow ? { kind: "run", id: run.id } : null);
  const open = review.comments.filter(isOpen).length;
  const diff = useRunDiff(run, open > 0);
  const files = diff.loaded ? diff.files : null;
  const batch = useMemo(
    () => reviewBatch(review.comments, files),
    [review.comments, files],
  );
  const check = useCallback((freeText) => checkFeedback(batch, freeText), [batch]);
  return { open, check, loading: review.loading || (open > 0 && diff.loading) };
}
