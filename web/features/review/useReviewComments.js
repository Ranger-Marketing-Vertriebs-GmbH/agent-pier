import { useCallback, useMemo } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import {
  afterWrite,
  reviewPath,
  reviewRequests,
  reviewState,
  reviewTopic,
} from "./review-comment-requests.js";

/**
 * The review comments of a session or run (`null` follows nothing), pushed on the
 * `session.review` / `pipeline.review` topic. Each write resolves once the change shows
 * (useLiveTopic written()). `batches` counts the batches sent so far.
 */
export default function useReviewComments(scope) {
  const kind = scope?.kind;
  const id = scope?.id;
  const stable = useMemo(() => (kind && id ? { kind, id } : null), [kind, id]);
  const topic = useLiveTopic(
    reviewTopic(stable),
    stable ? reviewPath(stable) : undefined,
  );
  const { written } = topic;
  const requests = useMemo(() => stable && reviewRequests(api, stable), [stable]);
  const after = useCallback((write) => afterWrite(write, written), [written]);
  return {
    ...reviewState(topic.data),
    loading: topic.loading,
    error: topic.error,
    create: (input) => after(() => requests.create(input)),
    update: (commentId, patch) => after(() => requests.update(commentId, patch)),
    remove: (commentId) => after(() => requests.remove(commentId)),
    markSent: (ids) => after(() => requests.markSent(ids)),
  };
}
