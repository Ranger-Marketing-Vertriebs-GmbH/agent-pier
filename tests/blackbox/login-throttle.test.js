import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { tailnetRequest, tailnetUrl } from "../helpers/tailnet.js";

const owner = { username: "owner", password: "temporary-owner-password" };
const wrong = { username: "owner", password: "x".repeat(16) };

test("a tailnet member who floods the sign-in locks out only herself", async (t) => {
  const f = await applicationFixture(t, {
    authenticateFixture: false,
    remoteUrl: tailnetUrl,
    ownerLogin: "owner@example.test",
  });
  assert.equal(
    (await f.request("/auth/setup", { method: "POST", body: owner })).status,
    201,
  );
  const member = "anna@example.test";
  const statuses = [];
  for (let attempt = 0; attempt < 11; attempt++)
    statuses.push((await tailnetRequest(f, member, "/auth/login", wrong)).status);
  assert.equal(statuses.at(-1), 429);
  assert.equal((await tailnetRequest(f, member, "/auth/login", owner)).status, 429);
  assert.equal(
    (await f.request("/auth/login", { method: "POST", body: owner })).status,
    200,
  );
  assert.equal(
    (await tailnetRequest(f, "owner@example.test", "/auth/login", owner)).status,
    200,
  );
});

test("refused attempts of one tailnet member never fill the shared tailnet window", async (t) => {
  const f = await applicationFixture(t, {
    authenticateFixture: false,
    remoteUrl: tailnetUrl,
    ownerLogin: "owner@example.test",
  });
  assert.equal(
    (await f.request("/auth/setup", { method: "POST", body: owner })).status,
    201,
  );
  const statuses = [];
  for (let attempt = 0; attempt < 35; attempt++)
    statuses.push(
      (await tailnetRequest(f, "anna@example.test", "/auth/login", wrong)).status,
    );
  assert.deepEqual(statuses.slice(10), Array(25).fill(429));
  assert.equal(
    (await tailnetRequest(f, "owner@example.test", "/auth/login", owner)).status,
    200,
  );
});

test("rotating tailnet logins stays inside one shared window", async (t) => {
  const f = await applicationFixture(t, {
    authenticateFixture: false,
    remoteUrl: tailnetUrl,
    ownerLogin: "owner@example.test",
  });
  assert.equal(
    (await f.request("/auth/setup", { method: "POST", body: owner })).status,
    201,
  );
  // A local process can forge the header; a fresh login per attempt must not reset the limit.
  const statuses = [];
  for (let attempt = 0; attempt < 31; attempt++)
    statuses.push(
      (await tailnetRequest(f, `x${attempt}@example.test`, "/auth/login", wrong)).status,
    );
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(401));
  assert.equal(statuses.at(-1), 429);
  assert.equal(
    (await f.request("/auth/login", { method: "POST", body: owner })).status,
    200,
  );
});

test("a full shared tailnet window never locks the owner's tailnet login out", async (t) => {
  const f = await applicationFixture(t, {
    authenticateFixture: false,
    remoteUrl: tailnetUrl,
    ownerLogin: "owner@example.test",
  });
  assert.equal(
    (await f.request("/auth/setup", { method: "POST", body: owner })).status,
    201,
  );
  for (let attempt = 0; attempt < 31; attempt++)
    await tailnetRequest(f, `x${attempt}@example.test`, "/auth/login", wrong);
  assert.equal(
    (await tailnetRequest(f, "y@example.test", "/auth/login", owner)).status,
    429,
  );
  assert.equal(
    (await tailnetRequest(f, "owner@example.test", "/auth/login", owner)).status,
    200,
  );
});
