import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserStore } from "../../server/features/users/user-store.js";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-user-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = Date.UTC(2026, 9, 20, 8);
  const f = {
    dataDir,
    options: { dataDir, now: () => time, ...options },
    advance: (duration) => {
      time += duration;
    },
    now: () => time,
  };
  f.store = new UserStore(f.options);
  return f;
}
const password = "disposable-user-password";

test("create stores only a hash and rejects taken names", async (t) => {
  let owner = null;
  const f = fixture(t, { ownerName: () => owner });
  const anna = await f.store.create({
    username: "Anna",
    displayName: "Anna K",
    password,
  });
  assert.equal(anna.username, "Anna");
  assert.equal(anna.displayName, "Anna K");
  assert.equal("salt" in anna, false);
  assert.equal("hash" in anna, false);
  assert.deepEqual(anna.ownerMayRead, { enabled: false, since: null });
  await assert.rejects(f.store.create({ username: "anna ", password }), {
    status: 409,
    code: "USER_NAME_TAKEN",
  });
  owner = "Ben";
  await assert.rejects(f.store.create({ username: " ben", password }), {
    status: 409,
    code: "USER_NAME_TAKEN",
  });
  await assert.rejects(f.store.create({ username: "", password }), {
    status: 400,
    code: "LOGIN_USERNAME_INVALID",
  });
  await assert.rejects(f.store.create({ username: "Cara", password: "short" }), {
    status: 400,
    code: "LOGIN_PASSWORD_INVALID",
  });
  const token = f.store.issue(anna.id);
  const file = path.join(f.dataDir, "users", "users.json");
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes(password), false);
  assert.equal(text.includes(token), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(new UserStore(f.options).list().length, 1);
});

test("disabled and removed users cannot verify or keep sessions", async (t) => {
  const f = fixture(t);
  const anna = await f.store.create({ username: "Anna", password });
  assert.equal(await f.store.verify({ username: " Anna ", password }), anna.id);
  assert.equal(await f.store.verify({ username: "anna", password }), null);
  assert.equal(
    await f.store.verify({ username: "Anna", password: "wrong-password" }),
    null,
  );
  const token = f.store.issue(anna.id);
  assert.ok(f.store.session(token));
  f.store.update(anna.id, { disabled: true });
  assert.equal(await f.store.verify({ username: "Anna", password }), null);
  assert.equal(f.store.session(token), null);
  f.store.update(anna.id, { disabled: false });
  const next = f.store.issue(anna.id);
  f.store.remove(anna.id);
  assert.equal(f.store.session(next), null);
  assert.throws(() => f.store.get(anna.id), { status: 404, code: "USER_NOT_FOUND" });
  assert.equal(await f.store.verify({ username: "Anna", password }), null);
});

test("owner opt-in records since and is not retroactive on re-enable", async (t) => {
  const f = fixture(t);
  const anna = await f.store.create({ username: "Anna", password });
  const t1 = new Date(f.now()).toISOString();
  assert.deepEqual(f.store.setOwnerMayRead(anna.id, true).ownerMayRead, {
    enabled: true,
    since: t1,
  });
  f.advance(60000);
  assert.deepEqual(f.store.setOwnerMayRead(anna.id, false).ownerMayRead, {
    enabled: false,
    since: null,
  });
  f.advance(60000);
  assert.deepEqual(f.store.setOwnerMayRead(anna.id, true).ownerMayRead, {
    enabled: true,
    since: new Date(f.now()).toISOString(),
  });
});

test("password changes revoke sessions as specified", async (t) => {
  const f = fixture(t);
  const anna = await f.store.create({ username: "Anna", password });
  const first = f.store.issue(anna.id);
  const second = f.store.issue(anna.id);
  await assert.rejects(
    f.store.changePassword(
      anna.id,
      { current: "wrong-password!", next: "another-password" },
      first,
    ),
    { status: 400, code: "USER_PASSWORD_WRONG" },
  );
  await f.store.changePassword(
    anna.id,
    { current: password, next: "another-password" },
    first,
  );
  assert.ok(f.store.session(first));
  assert.equal(f.store.session(second), null);
  assert.equal(
    await f.store.verify({ username: "Anna", password: "another-password" }),
    anna.id,
  );
  await f.store.resetPassword(anna.id, "reset-by-the-owner");
  assert.equal(f.store.session(first), null);
  assert.equal(
    await f.store.verify({ username: "Anna", password: "reset-by-the-owner" }),
    anna.id,
  );
});

test("corrupt user state fails closed", async (t) => {
  const f = fixture(t);
  await f.store.create({ username: "Anna", password });
  const file = path.join(f.dataDir, "users", "users.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, users: [{ id: "x" }], sessions: [] }),
  );
  assert.throws(() => new UserStore(f.options), /Invalid private user state/);
});

test("password changes allow ten checks of the current password per minute", async (t) => {
  let hashes = 0;
  const f = fixture(t, {
    hashPassword: async (value, salt) => {
      hashes++;
      return Buffer.from(`${salt}:${value}`.padEnd(64, "0").slice(0, 64));
    },
  });
  const anna = await f.store.create({ username: "Anna", password });
  const change = (current) =>
    f.store.changePassword(anna.id, { current, next: "another-user-password" });
  // Parallel guesses count before any hash starts.
  const guesses = await Promise.allSettled(
    Array.from({ length: 12 }, () => change("wrong-user-password")),
  );
  const throttled = guesses.filter((result) => result.reason?.code === "LOGIN_THROTTLED");
  assert.equal(throttled.length, 2);
  assert.equal(throttled[0].reason.status, 429);
  const counted = hashes;
  await assert.rejects(change(password), { status: 429, code: "LOGIN_THROTTLED" });
  assert.equal(hashes, counted);
  f.advance(60000);
  await change(password);
});
