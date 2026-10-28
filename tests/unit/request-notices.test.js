import test from "node:test";
import assert from "node:assert/strict";
import {
  RequestNotices,
  terminalNoticeMs,
} from "../../server/features/requests/request-notices.js";
import { fakeEnv } from "../helpers/fake-browser.js";

const approval = (id, sessionId = "s1") => ({
  id,
  sessionId,
  source: "claude",
  kind: "permission",
});

test("a terminal notice reports its appearance, clearing and fading", async () => {
  const fake = fakeEnv();
  const changes = [];
  const notices = new RequestNotices({
    onChange: (id) => changes.push(id),
    timers: fake.env,
  });
  notices.terminal(approval("a"));
  assert.deepEqual(notices.get("s1"), { id: "a", reason: "terminal" });
  assert.deepEqual(changes, ["s1"]);
  await fake.advance(terminalNoticeMs - 1);
  assert.deepEqual(changes, ["s1"]);
  await fake.advance(1);
  assert.deepEqual(changes, ["s1", "s1"]);
  assert.equal(notices.records.size, 0);
  notices.terminal(approval("b"));
  notices.clear("s1");
  notices.clear("s1");
  assert.deepEqual(changes, ["s1", "s1", "s1", "s1"]);
  // A cleared notice leaves no timer behind.
  assert.equal(fake.timers.size, 0);
});

test("a newer notice restarts the fading", async () => {
  const fake = fakeEnv();
  const notices = new RequestNotices({ timers: fake.env });
  notices.terminal(approval("a"));
  await fake.advance(terminalNoticeMs / 2);
  notices.terminal(approval("b"));
  assert.equal(fake.timers.size, 1);
});

test("only a plain Claude approval leaves a notice", () => {
  const changes = [];
  const notices = new RequestNotices({ onChange: (id) => changes.push(id) });
  notices.terminal({ ...approval("a"), source: "codex" });
  notices.terminal({ ...approval("a"), kind: "question" });
  notices.terminal({ ...approval("a"), presentation: "claudeLegacyQuestion" });
  notices.terminal({ ...approval("a"), local: true });
  assert.deepEqual(changes, []);
  assert.equal(notices.get("s1"), undefined);
  notices.close();
});
