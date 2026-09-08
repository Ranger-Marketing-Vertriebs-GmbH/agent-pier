import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture, fixtureFetch as fetch } from "../helpers/application.js";

async function json(response, expected) {
  assert.equal(response.status, expected);
  return response.json();
}

test("HTTP account and GitHub metadata persist across a full application restart without exposing secrets", async (t) => {
  const fixture = await applicationFixture(t);
  const account = await json(
    await fixture.request("/api/accounts", {
      method: "POST",
      body: {
        name: "Persisted account",
        tool: "claude",
        apiKey: "fixture-account-secret",
      },
    }),
    201,
  );
  const credential = await json(
    await fixture.request("/api/git-credentials", {
      method: "POST",
      body: {
        name: "Persisted host",
        host: "enterprise.example.test",
        token: "fixture-github-secret",
      },
    }),
    201,
  );
  assert.equal(account.hasSecret, true);
  assert.equal(credential.hasSecret, true);
  await fixture.restart();
  const state = await json(await fixture.request("/api/state"), 200);
  const repositories = await json(await fixture.request("/api/repositories"), 200);
  assert.equal(
    state.accounts.find((item) => item.id === account.id).name,
    "Persisted account",
  );
  assert.equal(
    repositories.credentials.find((item) => item.id === credential.id).host,
    "https://enterprise.example.test",
  );
  assert.equal(
    JSON.stringify({ account, credential, state, repositories }).includes(
      "fixture-account-secret",
    ),
    false,
  );
  assert.equal(JSON.stringify(repositories).includes("fixture-github-secret"), false);
  assert.equal(
    (await fixture.request(`/api/accounts/${account.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (
      await fixture.request(`/api/git-credentials/${credential.id}`, {
        method: "DELETE",
      })
    ).status,
    204,
  );
});

test("HTTP origin and malformed-input boundaries reject mutations without creating state or leaking inputs", async (t) => {
  const fixture = await applicationFixture(t);
  await assert.rejects(
    fixture.request("https://foreign.example/api/state"),
    /own application origin/,
  );
  const before = await json(await fixture.request("/api/state"), 200);
  const payload = {
    name: "Rejected",
    tool: "codex",
    apiKey: "fixture-error-secret",
  };
  for (const origin of ["https://foreign.example", "null", null]) {
    const response = await fixture.request("/api/accounts", {
      method: "POST",
      origin,
      body: payload,
    });
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes(payload.apiKey), false);
  }
  const malformed = await fetch(`${fixture.url}/api/accounts`, {
    method: "POST",
    headers: { origin: fixture.url, "content-type": "application/json" },
    body: '{"apiKey":"fixture-error-secret",',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes(payload.apiKey), false);
  const after = await json(await fixture.request("/api/state"), 200);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(after.sessions, []);
  for (const endpoint of [
    "/.data/accounts.json",
    "/.data/repository-secrets/unknown.json",
  ])
    assert.notEqual((await fixture.request(endpoint)).status, 200);
  const missing = await fixture.request("/api/accounts/absent-profile", {
    method: "PATCH",
    body: { name: "Missing", apiKey: payload.apiKey },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.text()).includes(payload.apiKey), false);
});

test("fixture shutdown removes only its temporary application data and private tmux directory", async (t) => {
  const fixture = await applicationFixture(t);
  const socketDirectory = path.dirname(fixture.application.sessions.socketPath);
  const sibling = `${fixture.root}-outside`;
  await fs.mkdir(sibling);
  t.after(() => fs.rm(sibling, { recursive: true, force: true }));
  await fixture.dispose();
  assert.equal(await fs.stat(fixture.root).catch(() => null), null);
  assert.equal(await fs.stat(socketDirectory).catch(() => null), null);
  assert.equal((await fs.stat(sibling)).isDirectory(), true);
});

test("a fixture-owned Shell session survives web-server restart and is removed through the HTTP lifecycle", async (t) => {
  const fixture = await applicationFixture(t);
  const session = await json(
    await fixture.request("/api/sessions", {
      method: "POST",
      body: {
        accountId: "local-shell",
        name: "Fixture shell",
        cwd: fixture.home,
      },
    }),
    201,
  );
  assert.equal(session.tool, "shell");
  assert.equal(session.status, "running");
  await fixture.restart();
  const state = await json(await fixture.request("/api/state"), 200);
  assert.equal(state.sessions.find((item) => item.id === session.id).status, "running");
  assert.equal(
    (await fixture.request(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
    409,
  );
  assert.equal(
    (
      await fixture.request(`/api/sessions/${session.id}/stop`, {
        method: "POST",
      })
    ).status,
    200,
  );
  assert.equal(
    (await fixture.request(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (
      await fixture.request("/api/state").then((response) => response.json())
    ).sessions.some((item) => item.id === session.id),
    false,
  );
});
