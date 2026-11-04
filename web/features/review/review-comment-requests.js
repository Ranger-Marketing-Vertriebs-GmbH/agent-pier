// The review-comment requests and topic of one scope ({ kind: "session" | "run", id }),
// pure so a unit test can drive them with a fake `api`.
const part = (scope) => encodeURIComponent(scope.id);

export const reviewTopic = (scope) =>
  scope ? `${scope.kind === "run" ? "pipeline" : "session"}.review:${scope.id}` : null;

export const reviewPath = (scope) =>
  `${scope.kind === "run" ? "/pipeline-runs" : "/sessions"}/${part(scope)}/review-comments`;

/** The writes of a scope; each resolves with the server's answer. */
export function reviewRequests(api, scope) {
  const base = reviewPath(scope);
  const one = (id) => `${base}/${encodeURIComponent(id)}`;
  return {
    create: (input) => api(base, "POST", input),
    update: (id, patch) => api(one(id), "PATCH", patch),
    remove: (id) => api(one(id), "DELETE"),
    markSent: (ids) => api(`${base}/sent`, "POST", { ids }),
  };
}

/** What the hook shows of a topic value: the comments and the batch counter. */
export const reviewState = (data) => ({
  comments: Array.isArray(data?.comments) ? data.comments : [],
  batches: Number.isSafeInteger(data?.batches) ? data.batches : 0,
});

/**
 * Runs a write, waits until its change shows (`written()`, the live topic's follow-up),
 * then returns the write's own answer. A refused write rejects without waiting.
 */
export async function afterWrite(write, written) {
  const answer = await write();
  await written();
  return answer;
}
