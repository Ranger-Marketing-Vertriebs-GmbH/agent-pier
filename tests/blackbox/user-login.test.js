import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { Identity } from "../../server/features/users/identity.js";

const owner = { username: "owner", password: "temporary-owner-password" };
const anna = { username: "Anna", password: "temporary-user-password" };
const post = (body, headers = {}) => ({ method: "POST", body, headers });
const cookieOf = (response) => response.headers.get("set-cookie").split(";")[0];

async function withUser(t) {
  const f = await applicationFixture(t, { authenticateFixture: false });
  const created = await f.request("/auth/setup", post(owner));
  const ownerCookie = cookieOf(created);
  const user = await f.application.users.create({ ...anna, displayName: "Anna K" });
  return { f, ownerCookie, user };
}

test("a user signs in with her own password and gets a user principal", async (t) => {
  const { f, ownerCookie, user } = await withUser(t);
  const login = await f.request("/auth/login", post(anna));
  assert.equal(login.status, 200);
  const cookie = cookieOf(login);
  assert.deepEqual(
    await (await f.request("/auth/status", { headers: { cookie } })).json(),
    {
      configured: true,
      authenticated: true,
      canSetup: false,
      role: "user",
      user: { id: user.id, username: "Anna", displayName: "Anna K" },
    },
  );
  const status = await (
    await f.request("/auth/status", { headers: { cookie: ownerCookie } })
  ).json();
  assert.equal(status.role, "owner");
  assert.equal(status.user, null);
  const anonymous = await (await f.request("/auth/status")).json();
  assert.equal(anonymous.role, null);
  const wrong = await f.request(
    "/auth/login",
    post({ ...anna, password: "x".repeat(16) }),
  );
  const unknown = await f.request(
    "/auth/login",
    post({ username: "Nobody", password: "x".repeat(16) }),
  );
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  const logout = await f.request("/auth/logout", post({}, { cookie }));
  assert.equal(logout.status, 204);
  const after = await (await f.request("/auth/status", { headers: { cookie } })).json();
  assert.equal(after.authenticated, false);
});

test("login compares the trimmed name case-sensitively", async (t) => {
  const { f } = await withUser(t);
  assert.equal(
    (await f.request("/auth/login", post({ ...anna, username: " Anna " }))).status,
    200,
  );
  assert.equal(
    (await f.request("/auth/login", post({ ...anna, username: "anna" }))).status,
    401,
  );
  assert.equal(
    (await f.request("/auth/login", post({ ...owner, username: "Owner" }))).status,
    401,
  );
});

test("user sessions never land in auth.json", async (t) => {
  const { f } = await withUser(t);
  assert.equal((await f.request("/auth/login", post(anna))).status, 200);
  const auth = JSON.parse(
    await fs.readFile(path.join(f.dataDir, "login", "auth.json"), "utf8"),
  );
  assert.equal(auth.sessions.length, 1);
  assert.equal(
    auth.sessions.some((row) => "userId" in row),
    false,
  );
  const users = JSON.parse(
    await fs.readFile(path.join(f.dataDir, "users", "users.json"), "utf8"),
  );
  assert.equal(users.sessions.length, 1);
});

test("disabling a user fires every watcher of her sessions", async (t) => {
  const { f, user } = await withUser(t);
  const identity = new Identity({
    login: f.application.login,
    users: f.application.users,
  });
  const token = await identity.login(anna, "unit");
  const row = identity.require(token);
  assert.deepEqual(identity.principal(row), { role: "user", userId: user.id });
  let closed = 0;
  t.after(identity.watch(row, () => closed++));
  f.application.users.update(user.id, { disabled: true });
  assert.equal(closed, 1);
  assert.equal(identity.session(token), null);
  assert.throws(() => identity.require(token), { status: 401, code: "LOGIN_REQUIRED" });
});
