import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

test("central access crosses the real HTTP lifecycle without exposing keys and retains session ownership after deletion", async (t) => {
  const f = await applicationFixture(t);
  const secret = "fixture-central-lifecycle-key";
  const created = await f.request("/api/provider-connections", {
    method: "POST",
    body: { name: "Shared router", providerId: "openrouter", apiKey: secret },
  });
  assert.equal(created.status, 201);
  const connection = await created.json();
  const executable = path.join(f.root, "version-fixture");
  await fs.writeFile(executable, "#!/bin/sh\nprintf '2.2.0\\n'\n", { mode: 0o755 });
  const original = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) => {
    const prepared = original(id, { claude: executable }, login, mode, options);
    assert.equal(prepared.env.ANTHROPIC_AUTH_TOKEN, secret);
    return { ...prepared, command: "/bin/sh", args: ["-c", "sleep 30"] };
  };
  const model = f.application.providerCatalog.list({
    providerId: "openrouter",
    tool: "claude",
  })[0];
  const body = {
    tool: "claude",
    providerConnectionId: connection.id,
    providerModelId: model.modelId,
    cwd: f.home,
  };
  const started = await f.request("/api/sessions", { method: "POST", body });
  assert.equal(started.status, 201);
  const session = await started.json();
  assert.equal(session.access.providerConnectionId, connection.id);
  assert.equal(session.access.providerConnectionName, "Shared router");
  assert.equal(session.provider.modelId, model.modelId);
  assert.equal(session.tool, "claude");
  const state = await (await f.request("/api/state")).json();
  assert.equal(state.providerConnections[0].hasSecret, true);
  assert.equal(
    state.accounts.some((account) => account.id === session.accountId),
    false,
  );
  assert.equal(JSON.stringify({ state, session, connection }).includes(secret), false);
  const audit = await (await f.request("/api/audit?action=provider.created")).json();
  assert.equal(audit.events[0]?.resourceId, connection.id);
  assert.equal(JSON.stringify(audit).includes(secret), false);
  assert.equal(
    (await f.request(`/api/provider-connections/${connection.id}`, { method: "DELETE" }))
      .status,
    204,
  );
  await f.restart();
  const restored = await f.application.sessions.get(session.id);
  assert.equal(restored.access.providerConnectionId, connection.id);
  assert.equal(restored.status, "running");
  assert.equal(f.application.accounts.get(restored.accountId).tool, "claude");
  assert.equal((await f.request("/api/sessions", { method: "POST", body })).status, 404);
});

test("the application rejects cross-CLI accounts before launching or generating a provider profile", async (t) => {
  const f = await applicationFixture(t);
  let commands = 0;
  f.application.accounts.command = () => {
    commands++;
    throw Error("must not launch");
  };
  for (const [tool, accountId] of [
    ["claude", "local-codex"],
    ["codex", "local-claude"],
    ["opencode", "local-claude"],
  ]) {
    const response = await f.request("/api/sessions", {
      method: "POST",
      body: { tool, accountId, cwd: f.home },
    });
    assert.equal(response.status, 400);
  }
  assert.equal(commands, 0);
  assert.equal((await f.application.sessions.list()).length, 0);
});
