import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

async function fixture(t) {
  const f = await applicationFixture(t);
  const created = await f.request("/api/accounts", {
    method: "POST",
    body: { name: "Reserved account", tool: "codex", apiKey: "fixture-old-key" },
  });
  assert.equal(created.status, 201);
  const account = await created.json();
  const command = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _bins, login, mode, options) => ({
    ...command(id, { codex: "/bin/sh" }, login, mode, options),
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
  });
  return { f, account };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const phase of ["capacity", "prepare"]) {
  for (const action of ["rotate", "delete"]) {
    test(`${action} refuses an account reserved during launch ${phase}`, async (t) => {
      const { f, account } = await fixture(t);
      const entered = deferred(),
        release = deferred();
      const owner =
        phase === "capacity" ? f.application.sessions : f.application.requests;
      const method = phase === "capacity" ? "list" : "prepare";
      const original = owner[method].bind(owner);
      let first = true;
      t.mock.method(owner, method, async (...args) => {
        const result = await original(...args);
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      });
      const starting = f.request("/api/sessions", {
        method: "POST",
        body: { accountId: account.id, cwd: f.home, agentbus: false },
      });
      await entered.promise;
      try {
        const mutation = await f.request(
          `/api/accounts/${account.id}`,
          action === "delete"
            ? { method: "DELETE" }
            : {
                method: "PATCH",
                body: { name: account.name, apiKey: "fixture-new-key" },
              },
        );
        assert.equal(mutation.status, 409);
      } finally {
        release.resolve();
      }
      assert.equal((await starting).status, 201);
      assert.equal(
        f.application.accounts.secret(f.application.accounts.get(account.id)).apiKey,
        "fixture-old-key",
      );
    });
  }
}

test("failed preparation releases account usage for credential edits", async (t) => {
  const { f, account } = await fixture(t);
  t.mock.method(f.application.requests, "prepare", async () => {
    throw Error("Fixture preparation failed");
  });
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: account.id, cwd: f.home, agentbus: false },
  });
  assert.equal(response.status, 400);
  const changed = await f.request(`/api/accounts/${account.id}`, {
    method: "PATCH",
    body: { name: account.name, apiKey: "fixture-new-key" },
  });
  assert.equal(changed.status, 200);
});

test("launch cannot enter while an account credential mutation awaits its idle check", async (t) => {
  const { f, account } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const list = f.application.sessions.list.bind(f.application.sessions);
  let first = true;
  t.mock.method(f.application.sessions, "list", async () => {
    const result = await list();
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  const changing = f.request(`/api/accounts/${account.id}`, {
    method: "PATCH",
    body: { name: account.name, apiKey: "fixture-new-key" },
  });
  await entered.promise;
  try {
    const started = await f.request("/api/sessions", {
      method: "POST",
      body: { accountId: account.id, cwd: f.home, agentbus: false },
    });
    assert.equal(started.status, 409);
  } finally {
    release.resolve();
  }
  assert.equal((await changing).status, 200);
  assert.equal((await f.application.sessions.list()).length, 0);
  assert.equal(
    f.application.accounts.secret(f.application.accounts.get(account.id)).apiKey,
    "fixture-new-key",
  );
});
