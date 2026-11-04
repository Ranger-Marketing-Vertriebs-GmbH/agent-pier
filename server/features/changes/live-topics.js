// The live review-comment topics, owner only: `session.review:<sessionId>` and
// `pipeline.review:<runId>` carry the same value as GET /api/sessions/:id/review-comments
// and GET /api/pipeline-runs/:id/review-comments. Every ReviewCommentStore write
// (ReviewCommentStore onChange) signals the topic of its scope through reviewChanged.
import { PIPELINE_PARAM } from "../pipelines/live-topics.js";

// The session id form of validId (sessions/session-validation.js), which the routes use.
export const REVIEW_SESSION_PARAM = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

const owner = (principal) => principal?.role === "owner";

/** Signals the topic of `scope` on `hub` (services.live, absent until it exists). */
export function reviewChanged(hub, scope) {
  if (typeof scope?.id !== "string") return;
  if (scope.kind === "session") hub?.invalidate("session.review", scope.id);
  else if (scope.kind === "run") hub?.invalidate("pipeline.review", scope.id);
}

const topic = (name, param, kind, services) => ({
  name,
  mode: "state",
  param,
  authorize: owner,
  scopeKey: () => "owner",
  read: (_principal, id) => services.reviewComments.list({ kind, id }),
});

export const sessionReviewTopic = (services) =>
  topic("session.review", REVIEW_SESSION_PARAM, "session", services);
export const pipelineReviewTopic = (services) =>
  topic("pipeline.review", PIPELINE_PARAM, "run", services);
