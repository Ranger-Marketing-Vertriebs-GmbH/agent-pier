import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("HTTP stop terminates a running replacement awaiting native verification", async (t) => {
  const f = await applicationFixture(t);
  const app = f.application;
  const session = await app.sessions.create({
    name: "Isolated pending replacement",
    tool: "codex",
    accountId: "fixture",
    cwd: f.home,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  await app.sessions.save({
    ...session,
    reload: { state: "reloading", replacementStarted: true, nativeId: "fixture" },
  });
  app.reload.pending.add(session.id);
  const response = await f.request(`/api/sessions/${session.id}/stop`, {
    method: "POST",
  });
  assert.equal(response.status, 200, await response.clone().text());
  const stopped = await response.json();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.reload.state, "idle");
  assert.equal(app.reload.pending.has(session.id), false);
  await app.reload.poll();
  assert.equal((await app.sessions.get(session.id)).status, "stopped");
});
