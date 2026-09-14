import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoginStore, sessionDuration } from "../../server/features/login/login-store.js";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-login-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = Date.now();
  const options = { dataDir, now: () => time };
  return {
    options,
    store: new LoginStore(options),
    advance: (duration) => {
      time += duration;
    },
  };
}
const credentials = { username: "fixture", password: "disposable-unit-password" };
test("expired and revoked tokens fail after restart and cookie strings cannot become credentials", async (t) => {
  const f = fixture(t);
  const token = await f.store.setup(credentials);
  for (const invalid of [
    null,
    "",
    "x".repeat(64),
    token + "x",
    "agentpier_session=" + token,
  ])
    assert.equal(f.store.session(invalid), null);
  assert.ok(new LoginStore(f.options).session(token));
  f.advance(sessionDuration);
  assert.equal(f.store.session(token), null);
  assert.equal(new LoginStore(f.options).session(token), null);
  const next = await f.store.login(credentials);
  f.store.revoke(next);
  assert.equal(new LoginStore(f.options).session(next), null);
});
test("session count is bounded and eviction revokes connected consumers", async (t) => {
  const f = fixture(t);
  const first = await f.store.setup(credentials);
  let closed = 0;
  const cleanup = f.store.watch(f.store.require(first), () => closed++);
  for (let i = 0; i < 20; i++) f.store.issue();
  assert.equal(f.store.session(first), null);
  assert.equal(closed, 1);
  cleanup();
  const data = JSON.parse(fs.readFileSync(f.store.file, "utf8"));
  assert.equal(data.sessions.length, 20);
});
test("corrupt login state never reopens first user setup", async (t) => {
  const f = fixture(t);
  await f.store.setup(credentials);
  fs.writeFileSync(f.store.file, JSON.stringify({ sessions: [], user: {} }));
  assert.throws(() => new LoginStore(f.options), /Invalid private login state/);
});
test("active consumers are disconnected at absolute session expiry", async (t) => {
  const f = fixture(t);
  const token = await f.store.setup(credentials);
  f.advance(sessionDuration - 15);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = 0;
  const cleanup = f.store.watch(f.store.require(token), () => closed++);
  t.after(cleanup);
  t.mock.timers.tick(14);
  assert.equal(closed, 0);
  f.advance(15);
  t.mock.timers.tick(1);
  assert.equal(closed, 1);
  assert.equal(f.store.session(token), null);
});
test("the attempt window is kept per source so a LAN flood never locks out loopback", async (t) => {
  const f = fixture(t);
  await f.store.setup(credentials, "127.0.0.1");
  const guess = { ...credentials, password: "incorrect-unit-password" };
  for (let attempt = 0; attempt < 10; attempt++)
    await assert.rejects(f.store.login(guess, "192.168.1.55"), { status: 401 });
  await assert.rejects(f.store.login(guess, "192.168.1.55"), { status: 429 });
  await assert.rejects(f.store.login(guess, "127.0.0.1"), { status: 401 });
  f.advance(60000);
  await assert.rejects(f.store.login(guess, "192.168.1.55"), { status: 401 });
});
test("the source window map stays bounded and drops the oldest source", async (t) => {
  const f = fixture(t);
  await f.store.setup(credentials, "127.0.0.1");
  const guess = { ...credentials, password: "incorrect-unit-password" };
  await assert.rejects(f.store.login(guess, "10.0.0.1"), { status: 401 });
  for (let index = 0; index < 1000; index++)
    await assert.rejects(f.store.login(guess, `10.1.${index >> 8}.${index & 255}`), {
      status: 401,
    });
  assert.equal(f.store.attempts.size, 1000);
  assert.equal(f.store.attempts.has("10.0.0.1"), false);
});
