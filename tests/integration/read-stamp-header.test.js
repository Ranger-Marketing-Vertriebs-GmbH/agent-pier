import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

// The application stamps its /api answers with the one read clock
// (server/lib/read-stamp.js) the live frames' readAt also follows.
const stampOf = (response) => {
  const value = Number(response.headers.get("x-read-started"));
  assert.ok(Number.isSafeInteger(value) && value > 0, `stamp ${value}`);
  return value;
};

test("GET and write answers under /api carry X-Read-Started on one rising clock", async (t) => {
  const f = await applicationFixture(t);
  const before = Date.now();
  const read = await f.request("/api/state");
  assert.equal(read.status, 200);
  const readAt = stampOf(read);
  // The server instance is the live channel's hello instance.
  assert.equal(read.headers.get("x-read-instance"), f.application.live.instance);
  assert.ok(readAt >= before);
  const write = await f.request("/api/operations/backups", { method: "POST", body: {} });
  assert.equal(write.status, 202);
  const writtenAt = stampOf(write);
  assert.ok(writtenAt > readAt);
  const again = await f.request("/api/state");
  assert.ok(stampOf(again) > writtenAt);
  // A refused write is stamped too: the clock is the server's, not the route's.
  const refused = await f.request("/api/sessions/no-such-session", {
    method: "DELETE",
  });
  assert.ok(refused.status >= 400);
  assert.ok(stampOf(refused) > writtenAt);
});
