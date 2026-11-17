import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { chatTaskRoutes } from "../../server/http/routes/chat-tasks.js";
import { registerResponses } from "../../server/http/responses.js";
import { TaskControl } from "../../server/features/chat/task-control.js";

async function app(t, driver) {
  const session = { id: "s1", tool: "claude", status: "running" };
  const snapshot = {
    observability: {
      stale: false,
      subagents: [{ id: "a1", name: "reviewer", status: "running" }],
      shells: [],
    },
  };
  const stopped = new Set();
  const control = new TaskControl({
    sessions: { get: async () => session },
    chat: { read: async () => snapshot },
    reads: { flags: () => ({}) },
    stops: {
      has: (_s, id) => stopped.has(id),
      get: (_s, id) => (stopped.has(id) ? { id, at: 0 } : null),
      record: (_s, { id }) => stopped.add(id),
    },
    onChange: () => {},
  });
  if (driver) control.register("claude", driver);
  const server = express();
  server.use("/api", chatTaskRoutes({ taskReads: {}, taskControl: control }));
  registerResponses(server);
  const listener = await new Promise((resolve) => {
    const started = server.listen(0, "127.0.0.1", () => resolve(started));
  });
  t.after(() => listener.close());
  return async (task) => {
    const response = await fetch(
      `http://127.0.0.1:${listener.address().port}/api/sessions/s1/tasks/${task}/stop`,
      { method: "POST" },
    );
    return { status: response.status, body: await response.json() };
  };
}
const driver = (result) => ({
  connected: () => true,
  canStop: () => true,
  stop: async () => result,
});

test("the stop route answers { stopped: true }", async (t) => {
  const post = await app(t, driver({ ok: true }));
  assert.deepEqual(await post("a1"), { status: 200, body: { stopped: true } });
});

test("a refusal carries its code and the CLI's reason", async (t) => {
  const post = await app(t, driver({ ok: false, reason: "No permission" }));
  const { status, body } = await post("a1");
  assert.equal(status, 409);
  assert.equal(body.code, "TASK_STOP_REFUSED");
  assert.equal(body.reason, "No permission");
});

test("a task of another session is unknown and no driver is unsupported", async (t) => {
  const post = await app(t, driver({ ok: true }));
  assert.equal((await post("other")).status, 404);
  const bare = await app(t);
  const { status, body } = await bare("a1");
  assert.deepEqual(
    [status, body.code, body.reason],
    [409, "TASK_STOP_UNSUPPORTED", undefined],
  );
});
