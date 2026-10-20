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
