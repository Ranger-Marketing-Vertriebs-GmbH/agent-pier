import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

const secret = "fixture-preparation-key";
const mutations = [
  { name: "delete", method: "DELETE", status: 204, expectedKey: null },
  {
    name: "remove key",
    method: "PATCH",
    body: { removeApiKey: true },
    status: 200,
    expectedKey: null,
  },
  {
    name: "rotate key",
    method: "PATCH",
    body: { apiKey: "fixture-rotated-key" },
    status: 200,
    expectedKey: "fixture-rotated-key",
  },
];
async function fixture(t, fail = false) {
  const f = await applicationFixture(t);
  const created = await f.request("/api/provider-connections", {
    method: "POST",
    body: { name: "Preparation fixture", providerId: "openrouter", apiKey: secret },
  });
  assert.equal(created.status, 201);
  const connection = await created.json();
  const version = path.join(f.root, "version-fixture");
  await fs.writeFile(version, "#!/bin/sh\nprintf '2.2.0\\n'\n", { mode: 0o755 });
  const command = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) => {
    const launch = command(id, { claude: version }, login, mode, options);
    assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, secret);
    return { ...launch, command: "/bin/sh", args: ["-c", "sleep 30"] };
  };
  let entered = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const prepare = f.application.github.prepare.bind(f.application.github);
  f.application.github.prepare = async (input) => {
    entered = true;
    await gate;
    if (fail)
      throw Object.assign(Error("Fixture launch preparation failed."), { status: 503 });
    return prepare(input);
  };
  const starting = f.request("/api/sessions", {
    method: "POST",
    body: {
      tool: "claude",
      providerConnectionId: connection.id,
      providerModelId: f.application.providerCatalog.list({
        providerId: "openrouter",
        tool: "claude",
      })[0].modelId,
      cwd: f.home,
    },
  });
  return {
    ...f,
    connection,
    release,
    starting,
    async ready() {
      const deadline = Date.now() + 3000;
      while (!entered && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(entered, true, "launch reached the controlled preparation boundary");
    },
  };
}
for (const mutation of mutations)
  test(`central connection ${mutation.name} is rejected until native launch finishes`, async (t) => {
    const f = await fixture(t);
    const endpoint = `/api/provider-connections/${f.connection.id}`;
    try {
      await f.ready();
      const rejected = await f.request(endpoint, {
        method: mutation.method,
        body: mutation.body,
      });
      assert.equal(rejected.status, 409);
      assert.equal((await rejected.text()).includes(secret), false);
      assert.equal(
        f.application.providerConnections.secret(f.connection.id).apiKey,
        secret,
      );
    } finally {
      f.release();
      await f.starting;
    }
    const launched = await f.starting;
    assert.equal(launched.status, 201);
    const session = await launched.json();
    assert.equal(session.access.providerConnectionId, f.connection.id);
    const accepted = await f.request(endpoint, {
      method: mutation.method,
      body: mutation.body,
    });
    assert.equal(accepted.status, mutation.status);
    assert.equal(
      f.application.providerConnections.secret(f.connection.id)?.apiKey ?? null,
      mutation.expectedKey,
    );
  });

test("failed native preparation releases the central connection mutation lease", async (t) => {
  const f = await fixture(t, true);
  const endpoint = `/api/provider-connections/${f.connection.id}`;
  try {
    await f.ready();
    assert.equal((await f.request(endpoint, { method: "DELETE" })).status, 409);
    assert.equal(
      f.application.providerConnections.secret(f.connection.id).apiKey,
      secret,
    );
  } finally {
    f.release();
    await f.starting;
  }
  assert.equal((await f.starting).status, 503);
  assert.equal((await f.application.sessions.list()).length, 0);
  assert.equal((await f.request(endpoint, { method: "DELETE" })).status, 204);
});
