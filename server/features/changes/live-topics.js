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

// `session.changes:<sessionId>` carries GET /api/sessions/:id/changes. The working tree
// announces nothing, so the topic is sampled every 60 s (like the AgentBus safety
// read) while a visible tab watches, and read at once on each `native-activity`
// event of the session (an agent turn starting or ending).
export const CHANGES_SAMPLE_MS = 60000;

/** The topic definition for LiveHub#define. `sampleMs` is for tests. */
export function sessionChangesTopic(services, { sampleMs = CHANGES_SAMPLE_MS } = {}) {
  return {
    name: "session.changes",
    mode: "state",
    param: REVIEW_SESSION_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    sampleMs,
    read: (_principal, id) => services.sessionChanges.summary(id),
    watch({ param, nudge }) {
      return services.chatEvents?.subscribe(
        param,
        (event) => event?.type === "native-activity" && nudge(),
      );
    },
  };
}
