import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { ReviewCommentStore } from "../../server/features/changes/review-comment-store.js";
import {
  pipelineReviewTopic,
  reviewChanged,
  sessionReviewTopic,
} from "../../server/features/changes/live-topics.js";
import { liveGate } from "../../server/application/live-wiring.js";
import { reviewCommentRoutes } from "../../server/http/routes/review-comments.js";
import { registerResponses } from "../../server/http/responses.js";
import { problem } from "../../server/lib/storage.js";
import { subscribe } from "../helpers/live-hub-subscriber.js";

const anchor = {
  side: "new",
  line: 3,
  text: "return ok();",
  before: ["a"],
  after: ["b"],
  excerpt: [{ kind: "add", text: "return ok();" }],
};
const body = {
  workspace: "",
  file: "server/a.js",
  side: "new",
  line: 3,
  anchor,
  body: "x",
};
const missing = () => problem("missing", 404);

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-review-routes-"));
  const hub = new LiveHub({
    debounceMs: 10,
    maxWaitMs: 50,
    gate: (p, topic) => liveGate(p, topic),
  });
  const reviewComments = new ReviewCommentStore({
    dataDir,
    onChange: (scope) => reviewChanged(hub, scope),
  });
  hub.define(sessionReviewTopic({ reviewComments }));
  hub.define(pipelineReviewTopic({ reviewComments }));
  const sessions = {
    get: async (id) => (id === "s1" ? { id } : Promise.reject(missing())),
  };
  const pipelines = {
    get: (id) =>
      id === "r1"
        ? { id }
        : (() => {
            throw missing();
          })(),
  };
  const application = express();
  application.use(express.json());
  application.use("/api", reviewCommentRoutes({ reviewComments, sessions, pipelines }));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => {
    server.close();
    hub.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const call = async (method, url, payload) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { call, hub, reviewComments, dataDir };
}

test("session comments round-trip over HTTP", async (t) => {
  const { call } = await fixture(t);
  const created = await call("POST", "/api/sessions/s1/review-comments", body);
  assert.equal(created.status, 201);
  const listed = await call("GET", "/api/sessions/s1/review-comments");
  assert.equal(listed.body.comments.length, 1);
  assert.equal(listed.body.batches, 0);
  const patched = await call(
    "PATCH",
    `/api/sessions/s1/review-comments/${created.body.id}`,
    { status: "resolved" },
  );
  assert.equal(patched.body.status, "resolved");
  assert.deepEqual(
    (
      await call("POST", "/api/sessions/s1/review-comments/sent", {
        ids: [created.body.id],
      })
    ).body,
    { batch: 1 },
  );
  assert.equal(
    (await call("DELETE", `/api/sessions/s1/review-comments/${created.body.id}`)).status,
    204,
  );
  assert.equal(
    (await call("GET", "/api/sessions/s1/review-comments")).body.comments.length,
    0,
  );
});

test("run comments have no workspace and no sent route", async (t) => {
  const { call } = await fixture(t);
  assert.equal(
    (
      await call("POST", "/api/pipeline-runs/r1/review-comments", {
        ...body,
        workspace: "w",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("POST", "/api/pipeline-runs/r1/review-comments", body)).status,
    201,
  );
  assert.equal(
    (await call("POST", "/api/pipeline-runs/r1/review-comments/sent", { ids: [] }))
      .status,
    404,
  );
});

test("an unknown session or run is 404 and stores nothing", async (t) => {
  const { call, dataDir } = await fixture(t);
  assert.equal((await call("GET", "/api/sessions/missing/review-comments")).status, 404);
  assert.equal(
    (await call("POST", "/api/pipeline-runs/missing/review-comments", body)).status,
    404,
  );
  assert.equal(
    (await call("POST", "/api/sessions/missing/review-comments", body)).status,
    404,
  );
  assert.equal(fs.existsSync(path.join(dataDir, "review-comments")), false);
});

test("a session id outside the session id form is refused", async (t) => {
  const { call } = await fixture(t);
  const response = await call("GET", `/api/sessions/${"a".repeat(81)}/review-comments`);
  assert.equal(response.status, 400);
});

test("sent validates 1..200 comment ids", async (t) => {
  const { call } = await fixture(t);
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const url = "/api/sessions/s1/review-comments/sent";
  for (const ids of [undefined, "x", [], ["nope"], [1], [uuid, 5], Array(201).fill(uuid)])
    assert.equal((await call("POST", url, { ids })).status, 400, JSON.stringify(ids));
  assert.equal((await call("POST", url, { ids: Array(200).fill(uuid) })).status, 200);
});

test("each write signals its topic and the topic reads the route's value", async (t) => {
  const { call, hub } = await fixture(t);
  const sub = subscribe(hub, "session.review:s1");
  t.after(() => sub.stop());
  await sub.next();
  const created = await call("POST", "/api/sessions/s1/review-comments", body);
  const frame = await sub.next((f) =>
    f.data?.comments?.some?.((c) => c.id === created.body.id),
  );
  assert.deepEqual(
    frame.data,
    (await call("GET", "/api/sessions/s1/review-comments")).body,
  );
  const run = subscribe(hub, "pipeline.review:r1");
  t.after(() => run.stop());
  await call("POST", "/api/pipeline-runs/r1/review-comments", body);
  await run.next((f) => f.data?.comments?.length === 1);
});

test("the topics are owner only", async (t) => {
  const { hub } = await fixture(t);
  const frames = [];
  const stop = hub.subscribe(
    { role: "user", userId: "u" },
    "session.review:s1",
    undefined,
    (f) => frames.push(f),
  );
  t.after(stop);
  // The hub answers a topic it will not show synchronously, with unknown-topic.
  assert.equal(
    frames.some((f) => f.code === "unknown-topic"),
    true,
  );
  assert.equal(
    frames.some((f) => f.data?.comments),
    false,
  );
});
