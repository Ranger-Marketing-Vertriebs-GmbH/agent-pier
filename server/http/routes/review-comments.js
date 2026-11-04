import { Router } from "express";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { commentInput } from "../../features/changes/review-comment-input.js";
import { validId } from "../../features/sessions/session-validation.js";

const MAX_SENT_IDS = 200;
const COMMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sentIds(body) {
  const ids = body?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_SENT_IDS ||
    !ids.every((id) => typeof id === "string" && COMMENT_ID.test(id))
  )
    throw problem(serverMessages.changes.invalidComment, 400);
  return ids;
}

/**
 * The owner's review comments of a session and of a pipeline run. Each route first
 * checks that the session or run exists, so an unknown id answers 404 and stores
 * nothing. Runs are marked sent by the server, so they have no `/sent` route.
 */
export function reviewCommentRoutes({ reviewComments, sessions, pipelines }) {
  const router = Router();
  const owners = {
    session: { base: "/sessions/:id", check: (id) => sessions.get(validId(id)) },
    run: { base: "/pipeline-runs/:id", check: (id) => pipelines.get(id) },
  };
  const handler = (kind, run) => async (req, res) => {
    await owners[kind].check(req.params.id);
    await run({ scope: { kind, id: req.params.id }, req, res });
  };
  for (const kind of Object.keys(owners)) {
    const base = `${owners[kind].base}/review-comments`;
    router.get(
      base,
      handler(kind, ({ scope, res }) => res.json(reviewComments.list(scope))),
    );
    router.post(
      base,
      handler(kind, ({ scope, req, res }) =>
        res
          .status(201)
          .json(reviewComments.create(scope, commentInput(req.body, { kind }))),
      ),
    );
    router.patch(
      `${base}/:commentId`,
      handler(kind, ({ scope, req, res }) =>
        res.json(reviewComments.update(scope, req.params.commentId, req.body ?? {})),
      ),
    );
    router.delete(
      `${base}/:commentId`,
      handler(kind, ({ scope, req, res }) => {
        reviewComments.remove(scope, req.params.commentId);
        res.status(204).end();
      }),
    );
  }
  router.post(
    "/sessions/:id/review-comments/sent",
    handler("session", ({ scope, req, res }) =>
      res.json(reviewComments.markSent(scope, sentIds(req.body))),
    ),
  );
  return router;
}
