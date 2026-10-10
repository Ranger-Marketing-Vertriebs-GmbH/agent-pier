import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRoutes } from "../../server/http/routes/assistants.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
test("reminder review route is owner-only and an unconfirmed replay asks for review", async (t) => {
  const calls = [],
    app = express();
  app.use(express.json());
  app.use((req, res, next) =>
    req.headers.authorization === "Bearer owner" ? next() : res.sendStatus(401),
  );
  app.use(
    assistantRoutes({
      assistantFeature: { enabled: true },
      assistants: { maintenance: false },
      assistantReminders: {
        review: async (...args) => {
          calls.push(args);
          return { id: args[1], status: "removed" };
        },
        create: async () => {
          throw Object.assign(assistantProblem("reminderReviewRequired", 409), {
            code: "REVIEW_REQUIRED",
          });
        },
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}/assistants/a/reminders`;
  const headers = { authorization: "Bearer owner", "content-type": "application/json" };
  const body = JSON.stringify({ acknowledgeUnknownOutcome: true });
  assert.equal((await fetch(`${url}/r/review`, { method: "POST", body })).status, 401);
  const reviewed = await fetch(`${url}/r/review`, { method: "POST", headers, body });
  assert.equal(reviewed.status, 200);
  assert.deepEqual(await reviewed.json(), { id: "r", status: "removed" });
  assert.deepEqual(calls, [["a", "r", { acknowledgeUnknownOutcome: true }]]);
  const replay = await fetch(url, { method: "POST", headers, body: "{}" });
  assert.equal(replay.status, 409);
  const problem = await replay.json();
  assert.equal(problem.code, "REVIEW_REQUIRED");
  assert.equal(problem.error, serverMessages.assistants.reminderReviewRequired);
  assert.equal(problem.messageKey, "assistants.reminderReviewRequired");
});
