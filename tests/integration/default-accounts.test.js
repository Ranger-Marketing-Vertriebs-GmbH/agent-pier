import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

// Catches ignored preferences, cross-CLI defaults, and credentials moved into OS home.
test("default accounts persist per CLI and retain managed credential isolation", async (t) => {
  const f = await applicationFixture(t);
  const codex = f.application.accounts.create({
    name: "Work",
    tool: "codex",
    apiKey: "fixture-key",
  });
  const claude = f.application.accounts.create({ name: "Personal", tool: "claude" });
  const patch = (body, options = {}) =>
    f.request("/api/preferences", { method: "PATCH", body, ...options });
  assert.equal(
    (await patch({ defaultAccountIds: { codex: codex.id } }, { origin: null })).status,
    403,
  );
  assert.equal((await patch({ defaultAccountIds: { codex: codex.id } })).status, 200);
  assert.equal((await patch({ defaultAccountIds: { claude: claude.id } })).status, 200);
  const work = path.join(f.root, "work");
  await fs.mkdir(work);
  assert.equal((await patch({ defaultCwd: work })).status, 200);
  await f.restart();
  const state = await (await f.request("/api/state")).json();
  assert.deepEqual(state.defaultAccountIds, { codex: codex.id, claude: claude.id });
  assert.equal(state.defaultCwd, work);
  for (const [tool, expected] of [
    ["codex", codex.id],
    ["claude", claude.id],
    ["opencode", "local-opencode"],
  ]) {
    assert.equal(f.application.providerAccess.resolve({ tool }).account.id, expected);
    assert.equal(
      f.application.providerAccess.resolve({ tool, accountId: `local-${tool}` }).account
        .id,
      `local-${tool}`,
    );
  }
  const launch = f.application.accounts.command(codex.id, { codex: process.execPath });
  assert.equal(
    launch.env.CODEX_HOME,
    path.join(f.dataDir, "profiles", codex.id, "codex"),
  );
  assert.equal(launch.env.HOME, f.home);
  await assert.rejects(fs.access(path.join(f.home, ".codex/auth.json")));
  assert.equal(
    (await fs.stat(path.join(f.dataDir, "preferences.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await patch({ defaultAccountIds: { codex: null } })).status, 200);
  assert.equal(
    f.application.providerAccess.resolve({ tool: "codex" }).account.id,
    "local-codex",
  );
  assert.equal(
    f.application.providerAccess.resolve({ tool: "claude" }).account.id,
    claude.id,
  );
});

test("invalid defaults are rejected atomically and removed accounts safely fall back", async (t) => {
  const f = await applicationFixture(t);
  const account = f.application.accounts.create({ name: "Work", tool: "codex" });
  const patch = (defaultAccountIds) =>
    f.request("/api/preferences", { method: "PATCH", body: { defaultAccountIds } });
  assert.equal((await patch({ codex: account.id })).status, 200);
  for (const value of [
    null,
    [],
    "bad",
    { shell: "local-shell" },
    { codex: "local-claude" },
    { codex: "missing" },
    { codex: 42 },
    { codex: account.id, claude: account.id },
  ]) {
    assert.equal((await patch(value)).status, 400);
    assert.equal(
      f.application.providerAccess.resolve({ tool: "codex" }).account.id,
      account.id,
    );
  }
  f.application.accounts.remove(account.id);
  assert.equal(
    f.application.providerAccess.resolve({ tool: "codex" }).account.id,
    "local-codex",
  );
  assert.deepEqual(
    (await (await f.request("/api/preferences")).json()).defaultAccountIds,
    {},
  );
  await f.restart();
  assert.equal(
    f.application.providerAccess.resolve({ tool: "codex" }).account.id,
    "local-codex",
  );
});

test("an in-flight directory change preserves a concurrently selected account default", async (t) => {
  const f = await applicationFixture(t);
  const account = f.application.accounts.create({ name: "Concurrent", tool: "claude" });
  const preferences = f.application.preferences;
  let release;
  preferences.directory = () =>
    new Promise((resolve) => {
      release = () => resolve(f.home);
    });
  const pending = preferences.update({ defaultCwd: f.home });
  await preferences.update({ defaultAccountIds: { claude: account.id } });
  release();
  await pending;
  assert.equal(preferences.get().defaultAccountIds.claude, account.id);
});
