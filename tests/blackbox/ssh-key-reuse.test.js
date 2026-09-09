import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("named keys are reused by hosts, renamed independently and protected while referenced", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await fetch(f.url + "/api/ssh-keys")).status, 401);
  const created = await f.request("/api/ssh-keys", {
    method: "POST",
    body: { name: "Lab administration" },
  });
  assert.equal(created.status, 201);
  const key = await created.json();
  assert.match(key.publicKey, /^ssh-ed25519 /);
  assert.equal(JSON.stringify(key).includes("PRIVATE KEY"), false);
  const hosts = [];
  for (const host of ["one.example.test", "two.example.test"]) {
    const response = await f.request("/api/ssh-accesses", {
      method: "POST",
      body: {
        name: host,
        host,
        username: "deploy",
        keyId: key.id,
        hostKey: key.publicKey,
      },
    });
    assert.equal(response.status, 201);
    const access = await response.json();
    assert.equal(access.keyId, key.id);
    assert.equal(access.fingerprint, key.fingerprint);
    hosts.push(access);
  }
  assert.equal((await (await f.request("/api/ssh-keys")).json()).keys.length, 1);
  const rename = await f.request(`/api/ssh-keys/${key.id}`, {
    method: "PATCH",
    body: { name: "Renamed key" },
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).name, "Renamed key");
  const accesses = (await (await f.request("/api/ssh-accesses")).json()).accesses;
  assert.deepEqual(
    accesses.map((row) => row.keyName),
    ["Renamed key", "Renamed key"],
  );
  assert.deepEqual(
    accesses.map((row) => row.id),
    hosts.map((row) => row.id),
  );
  assert.equal(
    (await f.request(`/api/ssh-keys/${key.id}`, { method: "DELETE" })).status,
    409,
  );
  await f.restart();
  assert.equal(
    (await (await f.request("/api/ssh-keys")).json()).keys[0].name,
    "Renamed key",
  );
  const other = await (
    await f.request("/api/ssh-keys", { method: "POST", body: { name: "Replacement" } })
  ).json();
  assert.equal(
    (
      await f.request(`/api/ssh-accesses/${hosts[0].id}`, {
        method: "PATCH",
        body: { keyId: other.id },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request(`/api/ssh-keys/${key.id}`, { method: "DELETE" })).status,
    409,
  );
  assert.equal(
    (await f.request(`/api/ssh-accesses/${hosts[1].id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (await f.request(`/api/ssh-keys/${key.id}`, { method: "DELETE" })).status,
    204,
  );
  const remaining = (await (await f.request("/api/ssh-keys")).json()).keys;
  assert.deepEqual(
    remaining.map((row) => row.id),
    [other.id],
  );
  assert.equal(remaining[0].hosts[0].id, hosts[0].id);
});
