import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";

const VALUE = "s3cr3t-value-ZZ-9f2";

test("the owner manages secrets without a value ever leaving the server", async (t) => {
  const f = await applicationFixture(t);
  const created = await f.request("/api/secrets", {
    method: "POST",
    body: { name: "API_KEY", description: "Billing", value: VALUE },
  });
  assert.equal(created.status, 201);
  const text = await created.text();
  assert.equal(text.includes(VALUE), false);
  const secret = JSON.parse(text);
  assert.equal(secret.name, "API_KEY");
  assert.equal("value" in secret, false);

  const listed = await f.request("/api/secrets");
  const listText = await listed.text();
  assert.equal(listText.includes(VALUE), false);
  const { secrets } = JSON.parse(listText);
  assert.deepEqual(
    secrets.map((s) => s.id),
    [secret.id],
  );
  assert.equal("value" in secrets[0], false);

  const patched = await f.request(`/api/secrets/${secret.id}`, {
    method: "PATCH",
    body: { description: "Changed" },
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).description, "Changed");
  assert.deepEqual(f.application.secrets.entries([secret.id]), [
    { name: "API_KEY", value: VALUE },
  ]);

  const summary = await (await f.request("/api/settings/summary")).json();
  assert.equal(summary.access.secrets.count, 1);

  assert.equal(
    (await f.request(`/api/secrets/${secret.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (await f.request(`/api/secrets/${secret.id}`, { method: "DELETE" })).status,
    404,
  );
});

test("unknown body keys and invalid input are refused", async (t) => {
  const f = await applicationFixture(t);
  const extra = await f.request("/api/secrets", {
    method: "POST",
    body: { name: "A", value: "v", extra: 1 },
  });
  assert.equal(extra.status, 400);
  const made = await (
    await f.request("/api/secrets", { method: "POST", body: { name: "A", value: "v" } })
  ).json();
  const patch = await f.request(`/api/secrets/${made.id}`, {
    method: "PATCH",
    body: { id: "x" },
  });
  assert.equal(patch.status, 400);
  const bad = await f.request("/api/secrets", {
    method: "POST",
    body: { name: "bad name", value: "v" },
  });
  assert.equal(bad.status, 400);
});

test("a restricted user cannot reach the secrets", async (t) => {
  const f = await applicationFixture(t);
  const { cookie } = await signedInUser(f);
  const headers = { cookie };
  assert.equal((await f.request("/api/secrets", { headers })).status, 404);
  const post = await f.request("/api/secrets", {
    method: "POST",
    headers,
    body: { name: "A", value: "v" },
  });
  assert.ok([403, 404].includes(post.status));
  assert.deepEqual(f.application.secrets.list(), []);
});
