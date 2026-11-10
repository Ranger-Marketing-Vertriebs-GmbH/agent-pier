import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const owner = { username: "owner", password: "temporary-owner-password" };
const anna = { username: "Anna", password: "temporary-user-password" };
const post = (body, headers = {}) => ({ method: "POST", body, headers });
const cookieOf = (response) => response.headers.get("set-cookie").split(";")[0];

test("sign-in, failed sign-in, lockout, sign-out and owner setup reach the audit log", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false });
  const rows = () =>
    f.application.audit
      .list()
      .events.filter((event) => event.resourceType === "login")
      .reverse();
  const created = await f.request("/auth/setup", post(owner));
  assert.equal(created.status, 201);
  const user = await f.application.users.create(anna);
  const wrong = await f.request("/auth/login", post({ ...owner, password: "wrong" }));
  assert.equal(wrong.status, 401);
  const userIn = await f.request("/auth/login", post(anna));
  assert.equal(userIn.status, 200);
  const out = await f.request("/auth/logout", post({}, { cookie: cookieOf(userIn) }));
  assert.equal(out.status, 204);
  // A sign-out without a session ends nothing and writes nothing.
  assert.equal((await f.request("/auth/logout", post({}))).status, 204);
  const ownerIn = await f.request("/auth/login", post(owner));
  assert.equal(ownerIn.status, 200);
  assert.deepEqual(
    rows().map(({ action, source, outcome, actorUserId, details }) => ({
      action,
      source,
      outcome,
      actorUserId,
      details,
    })),
    [
      ["login.created", "user", "success", undefined, { branch: "local" }],
      [
        "login.failed",
        "system",
        "failure",
        undefined,
        { branch: "local", reason: "credentials" },
      ],
      ["login.started", "user", "success", user.id, { branch: "local" }],
      ["login.ended", "user", "success", user.id, { branch: "local" }],
      ["login.started", "user", "success", undefined, { branch: "local" }],
    ].map(([action, source, outcome, actorUserId, details]) => ({
      action,
      source,
      outcome,
      actorUserId,
      details,
    })),
  );
  // Six more wrong passwords use up the window of ten; the refusals after it write one row.
  for (let attempt = 0; attempt < 6; attempt++)
    await f.request("/auth/login", post({ ...owner, password: "wrong" }));
  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal((await f.request("/auth/login", post(owner))).status, 429);
  const denied = rows().filter((event) => event.action === "login.denied");
  assert.equal(denied.length, 1);
  assert.deepEqual(denied[0].details, { branch: "local", reason: "throttled" });
  const written = JSON.stringify(rows());
  for (const secret of [owner.password, anna.password, "wrong", owner.username, "Anna"])
    assert.equal(written.includes(secret), false, secret);
  for (const cookie of [cookieOf(created), cookieOf(userIn), cookieOf(ownerIn)])
    assert.equal(written.includes(cookie.split("=")[1]), false);
  // The owner reads them in the activity log like every other entry.
  const page = await f.request("/api/audit?action=login.started", {
    headers: { cookie: cookieOf(ownerIn) },
  });
  assert.equal((await page.json()).total, 2);
});

test("a login row keeps the branch, the reason and a network address, nothing else", () => {
  const event = auditEvent({
    action: "login.failed",
    resourceType: "login",
    source: "system",
    outcome: "failure",
    details: {
      branch: "network",
      reason: "setup-code",
      address: "192.168.1.55",
      username: "owner",
      password: "never-kept",
      setupCode: "AAAA-AAAA-AAAA",
    },
  });
  assert.deepEqual(event.details, {
    branch: "network",
    reason: "setup-code",
    address: "192.168.1.55",
  });
  const odd = auditEvent({
    action: "login.started",
    resourceType: "login",
    source: "user",
    outcome: "success",
    details: { branch: "elsewhere", reason: "other", address: "not an address" },
  });
  assert.deepEqual(odd.details, {});
});
