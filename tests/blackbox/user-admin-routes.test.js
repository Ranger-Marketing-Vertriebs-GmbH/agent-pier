import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { signIn, signedInUser, userPassword } from "../helpers/users.js";

const json = (response) => response.json();
const user = { username: "Anna", displayName: "Anna K", password: userPassword };

test("owner manages users", async (t) => {
  const f = await applicationFixture(t);
  let response = await f.request("/api/users", { method: "POST", body: user });
  assert.equal(response.status, 201);
  const created = await json(response);
  assert.equal(created.username, "Anna");
  response = await f.request("/api/users", {
    method: "POST",
    body: { ...user, username: "anna" },
  });
  assert.equal(response.status, 409);
  assert.equal((await json(response)).code, "USER_NAME_TAKEN");
  const list = await json(await f.request("/api/users"));
  assert.equal(list.length, 1);
  assert.equal("salt" in list[0], false);
  assert.equal("hash" in list[0], false);
  response = await f.request(`/api/users/${created.id}`, {
    method: "PATCH",
    body: { displayName: "Anna Kaulig" },
  });
  assert.equal((await json(response)).displayName, "Anna Kaulig");
  const cookie = await signIn(f, "Anna");
  const asAnna = (endpoint) => f.request(endpoint, { headers: { cookie } });
  assert.equal((await asAnna("/api/me")).status, 200);
  response = await f.request(`/api/users/${created.id}`, {
    method: "PATCH",
    body: { disabled: true },
  });
  assert.equal((await json(response)).disabled, true);
  assert.equal((await asAnna("/api/me")).status, 401);
  await f.request(`/api/users/${created.id}`, {
    method: "PATCH",
    body: { disabled: false },
  });
  const again = await signIn(f, "Anna");
  response = await f.request(`/api/users/${created.id}/password`, {
    method: "POST",
    body: { password: "reset-by-the-owner" },
  });
  assert.equal(response.status, 204);
  assert.equal((await f.request("/api/me", { headers: { cookie: again } })).status, 401);
  const reset = await signIn(f, "Anna", "reset-by-the-owner");
  response = await f.request(`/api/users/${created.id}`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal((await f.request("/api/me", { headers: { cookie: reset } })).status, 401);
  assert.deepEqual(await json(await f.request("/api/users")), []);
  assert.equal(
    (await f.request(`/api/users/${created.id}`, { method: "DELETE" })).status,
    404,
  );
});

test("a user changes her own password and keeps only this session", async (t) => {
  const f = await applicationFixture(t);
  const { user: anna, cookie } = await signedInUser(f, "Anna", "Anna K");
  const other = await signIn(f, "Anna");
  const me = await json(await f.request("/api/me", { headers: { cookie } }));
  assert.deepEqual(me, {
    user: { id: anna.id, username: "Anna", displayName: "Anna K" },
    ownerMayRead: { enabled: false, since: null },
  });
  let response = await f.request("/api/me/password", {
    method: "PUT",
    headers: { cookie },
    body: { current: "not-the-password", next: "a-new-user-password" },
  });
  assert.equal(response.status, 400);
  assert.equal((await json(response)).code, "USER_PASSWORD_WRONG");
  response = await f.request("/api/me/password", {
    method: "PUT",
    headers: { cookie },
    body: { current: userPassword, next: "a-new-user-password" },
  });
  assert.equal(response.status, 204);
  assert.equal((await f.request("/api/me", { headers: { cookie } })).status, 200);
  assert.equal((await f.request("/api/me", { headers: { cookie: other } })).status, 401);
  await signIn(f, "Anna", "a-new-user-password");
});

test("owner cannot use /api/me and users cannot use /api/users", async (t) => {
  const f = await applicationFixture(t);
  const { user: anna, cookie } = await signedInUser(f);
  const unknown = await json(await f.request("/api/does-not-exist"));
  for (const [endpoint, options] of [
    ["/api/me", {}],
    ["/api/me/password", { method: "PUT", body: { current: "x", next: "y" } }],
  ]) {
    const response = await f.request(endpoint, options);
    assert.equal(response.status, 404, endpoint);
    assert.deepEqual(await json(response), unknown);
  }
  for (const [endpoint, method] of [
    ["/api/users", "GET"],
    ["/api/users", "POST"],
    [`/api/users/${anna.id}`, "PATCH"],
    [`/api/users/${anna.id}`, "DELETE"],
    [`/api/users/${anna.id}/password`, "POST"],
  ]) {
    const response = await f.request(endpoint, {
      method,
      headers: { cookie },
      ...(method === "GET" ? {} : { body: {} }),
    });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.deepEqual(await json(response), unknown);
  }
});

test("a user's password change is audited with her id and without secrets", async (t) => {
  const f = await applicationFixture(t);
  await f.request("/api/users", { method: "POST", body: user });
  const anna = f.application.users.list()[0];
  const cookie = await signIn(f, "Anna");
  await f.request("/api/me/password", {
    method: "PUT",
    headers: { cookie },
    body: { current: userPassword, next: "a-new-user-password" },
  });
  await f.request(`/api/users/${anna.id}/password`, {
    method: "POST",
    body: { password: "reset-by-the-owner" },
  });
  const { events } = await json(await f.request("/api/audit"));
  const text = JSON.stringify(events);
  for (const secret of [userPassword, "a-new-user-password", "reset-by-the-owner"])
    assert.equal(text.includes(secret), false);
  const [reset, changed, created] = events;
  assert.equal(created.action, "user.created");
  assert.equal(created.resourceId, anna.id);
  assert.equal(created.actorUserId, undefined);
  assert.equal(changed.action, "user.updated");
  assert.equal(changed.resourceId, anna.id);
  assert.equal(changed.actorUserId, anna.id);
  assert.equal(changed.details.kind, "password-changed");
  assert.equal(reset.action, "user.updated");
  assert.equal(reset.details.kind, "password-reset");
  assert.equal(reset.actorUserId, undefined);
});
