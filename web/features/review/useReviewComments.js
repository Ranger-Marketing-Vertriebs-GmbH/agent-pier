import { useCallback, useMemo } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import {
  afterWrite,
  reviewPath,
  reviewRequests,
  reviewState,
  reviewTopic,
  writesOf,
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
  const writes = useMemo(() => writesOf(requests, after), [requests, after]);
  return {
    ...reviewState(topic.data),
    loading: topic.loading,
    error: topic.error,
    ...writes,
  };
}
