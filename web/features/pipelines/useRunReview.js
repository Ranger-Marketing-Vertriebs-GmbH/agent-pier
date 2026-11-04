import { useCallback } from "react";
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
 * What a gate's feedback sends with `review: true`: the free text and the run's open
 * comments, relocated against the whole-run diff (`files`, null while it is unknown:
 * every comment is then outdated, as the server sends it without a diff). The same
 * text and byte count as the server's check (server/features/pipelines/
 * review-feedback.js); without open comments the free text goes as typed.
 * @param {{ freeText: string, comments: Comment[], files: DiffFile[] | null }} input
 */
export function reviewCheck({ freeText, comments, files }) {
  const open = comments.filter(isOpen);
  const text = open.length
    ? combineFeedback(
        freeText ?? "",
        formatReviewBatch(
          reviewEntries(open, files ? new Map([["", files]]) : new Map()),
        ),
      )
    : (freeText ?? "");
  const bytes = feedbackBytes(text);
  return { open: open.length, text, bytes, fits: bytes <= REVIEW_FEEDBACK_LIMIT };
}

/**
 * The run's open review comments for a gate form that sends feedback (`enabled`):
 * their count and `check(freeText)`, the size check of what the gate would send. The
 * whole-run diff is read only while open comments exist.
 */
export default function useRunReview(run, enabled = true) {
  const follow = enabled && run?.id && run.imported?.historyOnly !== true;
  const review = useReviewComments(follow ? { kind: "run", id: run.id } : null);
  const open = review.comments.filter(isOpen).length;
  const diff = useRunDiff(run, open > 0);
  const files = diff.loaded ? diff.files : null;
  const check = useCallback(
    (freeText) => reviewCheck({ freeText, comments: review.comments, files }),
    [review.comments, files],
  );
  return { open, check, loading: review.loading || (open > 0 && diff.loading) };
}
