import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { tailnetRequest, tailnetUrl as remoteUrl } from "../helpers/tailnet.js";

const owner = { username: "owner", password: "temporary-owner-password" };

const tailnet = tailnetRequest;

test("a tailnet member who is not the owner can never create the owner", async (t) => {
  const f = await applicationFixture(t, {
    authenticateFixture: false,
    remoteUrl,
    ownerLogin: "owner@example.test",
  });
  const member = "anna@example.test";
  assert.equal((await tailnet(f, member, "/auth/status")).data.canSetup, false);
  const refused = await tailnet(f, member, "/auth/setup", owner);
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, "LOGIN_SETUP_LOCAL_ONLY");
  assert.equal(f.application.login.configured, false);
  assert.equal(
    (await tailnet(f, "owner@example.test", "/auth/status")).data.canSetup,
    true,
  );
  // The documented recovery: auth.json goes, users and the tailnet stay.
  assert.equal(
    (await f.request("/auth/setup", { method: "POST", body: owner })).status,
    201,
  );
  await f.application.users.create({
    username: "Anna",
    password: "temporary-user-password",
  });
  await fs.rm(path.join(f.dataDir, "login", "auth.json"));
  await f.restart();
  assert.equal((await tailnet(f, member, "/auth/setup", owner)).status, 403);
  assert.equal(
    (await tailnet(f, "owner@example.test", "/auth/setup", owner)).status,
    201,
  );
});

test("a re-created owner cannot take a user's name", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false });
  const setup = (body) => f.request("/auth/setup", { method: "POST", body });
  assert.equal((await setup(owner)).status, 201);
  const anna = { username: "Anna", password: "temporary-user-password" };
  await f.application.users.create(anna);
  await fs.rm(path.join(f.dataDir, "login", "auth.json"));
  await f.restart();
  const taken = await setup({ ...owner, username: " anna " });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).code, "LOGIN_USERNAME_TAKEN");
  assert.equal(f.application.login.configured, false);
  assert.equal((await setup(owner)).status, 201);
  assert.equal(
    (await f.request("/auth/login", { method: "POST", body: anna })).status,
    200,
  );
});
