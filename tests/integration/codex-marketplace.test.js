import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

const remote = "openai-curated-remote";
const plugin = (name, marketplaceName = remote) => ({
  pluginId: `${name}@${marketplaceName}`,
  name,
  marketplaceName,
});
async function fixture(t) {
  const f = await applicationFixture(t);
  const { accounts, plugins, sharedProfiles } = f.application;
  const a = accounts.create({ name: "Catalog A", tool: "codex" });
  const b = accounts.create({ name: "Catalog B", tool: "codex" });
  const claude = accounts.create({ name: "Wrong CLI", tool: "claude" });
  sharedProfiles.prepare(a, {});
  sharedProfiles.prepare(b, {});
  const calls = [];
  const state = { failRemote: false, hold: null };
  plugins.resolveTool = () => "/fixture/codex";
  plugins.runner = async (_command, args, options) => {
    const accountId =
      options.env.CODEX_HOME === path.join(accounts.profile(a.id), "codex")
        ? a.id
        : options.env.CODEX_HOME === path.join(accounts.profile(b.id), "codex")
          ? b.id
          : "local-codex";
    calls.push({ args, accountId });
    if (accountId !== "local-codex" && state.hold) await state.hold;
    if (args.includes("marketplace"))
      return JSON.stringify({
        marketplaces: [
          {
            name: "local",
            marketplaceSource: { source: "example/local", sourceType: "git" },
          },
        ],
      });
    if (args.includes("list")) {
      if (accountId !== "local-codex" && state.failRemote)
        throw Object.assign(Error("Synthetic remote unavailable"), { status: 502 });
      return JSON.stringify({
        installed:
          accountId === "local-codex"
            ? [plugin("shared", "local"), plugin("local-account-only")]
            : accountId === a.id
              ? [plugin("a-installed")]
              : [],
        available:
          accountId === "local-codex"
            ? [plugin("local-new", "local"), plugin("bundled", "bundled-native")]
            : [plugin("a-installed"), plugin("remote-new")],
      });
    }
    return "{}";
  };
  const list = async (id) => {
    const response = await f.request(
      `/api/accounts/local-codex/plugins${id ? `?catalogAccountId=${id}` : ""}`,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  return { f, accounts, plugins, a, b, claude, state, calls, list };
}

test("Codex exposes implicit default marketplace and explicitly scoped native catalog accounts", async (t) => {
  const x = await fixture(t);
  const base = await x.list();
  assert.equal(base.catalogAccountId, "local-codex");
  assert.deepEqual(base.noteCodes, ["restartRequired", "codexActivation"]);
  assert.equal(base.catalogReasonCode, null);
  assert.deepEqual(
    base.catalogAccounts.map(({ id }) => id),
    ["local-codex", x.a.id, x.b.id],
  );
  assert.deepEqual(
    base.marketplaces.find(({ name }) => name === remote),
    {
      name: remote,
      builtin: true,
      source: "Nativer Codex-Standardkatalog des ausgewählten Kontos",
      removable: false,
      updatable: false,
    },
  );
  assert.equal(
    base.marketplaces.find(({ name }) => name === "bundled-native").removable,
    false,
  );
  const selected = await x.list(x.a.id);
  assert.equal(selected.catalogAccountId, x.a.id);
  assert.equal(selected.catalogReasonCode, null);
  assert.deepEqual(
    selected.installed.map(({ id }) => id),
    ["shared@local", "a-installed@openai-curated-remote"],
  );
  assert.equal(
    selected.catalog.find(({ id }) => id === "a-installed@openai-curated-remote")
      .installed,
    true,
  );
  const other = await x.list(x.b.id);
  assert.equal(
    other.catalog.find(({ id }) => id === "a-installed@openai-curated-remote").installed,
    false,
  );
  assert.ok(!JSON.stringify(other).includes("local-account-only"));
});

test("empty remote catalogs expose a stable reason without removing the legacy message", async (t) => {
  const x = await fixture(t);
  const original = x.plugins.runner;
  x.plugins.runner = async (...args) => {
    const result = JSON.parse(await original(...args));
    for (const key of ["installed", "available"])
      if (result[key])
        result[key] = result[key].filter((item) => item.marketplaceName !== remote);
    return JSON.stringify(result);
  };
  const empty = await x.list(x.a.id);
  assert.equal(empty.catalogReasonCode, "empty");
  assert.match(empty.catalogReason, /keine Standard-Plugins/);
});

test("remote installs and removals use only the explicit account; local mutations remain shared", async (t) => {
  const x = await fixture(t);
  for (const [action, pluginId, expected] of [
    ["install", `remote-new@${remote}`, x.a.id],
    ["remove", `a-installed@${remote}`, x.a.id],
    ["install", "local-new@local", "local-codex"],
  ]) {
    const response = await x.f.request("/api/accounts/local-codex/plugins", {
      method: "POST",
      body: { action, pluginId, catalogAccountId: x.a.id },
    });
    assert.equal(response.status, 200);
    assert.equal(x.calls.at(-1).accountId, expected);
    assert.deepEqual(x.calls.at(-1).args, [
      "plugin",
      action === "install" ? "add" : "remove",
      pluginId,
      "--json",
    ]);
  }
  const forbidden = await x.f.request("/api/accounts/local-codex/plugins", {
    method: "POST",
    body: { action: "marketplace-remove", marketplace: remote, catalogAccountId: x.a.id },
  });
  assert.equal(forbidden.status, 409);
});

test("invalid or cross-CLI selections are rejected before invoking a CLI", async (t) => {
  const x = await fixture(t);
  for (const selection of [
    `${x.a.id}&catalogAccountId=${x.b.id}`,
    x.claude.id,
    "%2Fetc%2Fpasswd",
  ]) {
    const response = await x.f.request(
      `/api/accounts/local-codex/plugins?catalogAccountId=${selection}`,
    );
    assert.equal(response.status, 400);
  }
  assert.equal(x.calls.length, 0);
});

test("remote inventory failure preserves usable shared plugins with an honest catalog reason", async (t) => {
  const x = await fixture(t);
  x.state.failRemote = true;
  const value = await x.list(x.a.id);
  assert.equal(value.available, true);
  assert.equal(value.installed[0].id, "shared@local");
  assert.ok(value.catalogReason);
  assert.equal(value.catalogReasonCode, "unavailable");
  assert.ok(value.marketplaces.some(({ name }) => name === remote));
  assert.ok(!value.installed.some(({ marketplace }) => marketplace === remote));
});

test("selected account reads cannot share another catalog cache or bypass account deletion guards", async (t) => {
  const x = await fixture(t);
  let release;
  x.state.hold = new Promise((resolve) => {
    release = resolve;
  });
  const first = x.list(x.a.id);
  while (!x.calls.some(({ accountId }) => accountId === x.a.id))
    await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(x.plugins.isBusy(x.a.id), true);
    const deleted = await x.f.request(`/api/accounts/${x.a.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 409);
  } finally {
    release();
  }
  assert.equal((await first).catalogAccountId, x.a.id);
  assert.equal((await x.list(x.b.id)).catalogAccountId, x.b.id);
});

test("a legitimate shared plugin-cache link is allowed but unrelated profile links fail closed", async (t) => {
  const x = await fixture(t);
  assert.equal((await x.list(x.a.id)).available, true);
  const pluginPath = path.join(x.accounts.profile(x.b.id), "codex", "plugins");
  await fs.rm(pluginPath, { recursive: true, force: true });
  const outside = path.join(x.f.root, "unrelated");
  await fs.mkdir(outside);
  await fs.symlink(outside, pluginPath);
  const response = await x.f.request(
    `/api/accounts/local-codex/plugins?catalogAccountId=${x.b.id}`,
  );
  assert.equal(response.status, 409);
});

test("a selected account cannot borrow credentials through an auth-file symlink", async (t) => {
  const x = await fixture(t);
  const otherAuth = path.join(x.accounts.profile(x.b.id), "codex", "auth.json");
  await fs.writeFile(
    otherAuth,
    JSON.stringify({ tokens: { access_token: "synthetic-private" } }),
  );
  await fs.symlink(
    otherAuth,
    path.join(x.accounts.profile(x.a.id), "codex", "auth.json"),
  );
  const response = await x.f.request(
    `/api/accounts/local-codex/plugins?catalogAccountId=${x.a.id}`,
  );
  assert.equal(response.status, 409);
  assert.equal(x.calls.length, 0);
});

test("configured names cannot make the native default marketplace editable", async (t) => {
  const x = await fixture(t);
  const original = x.plugins.runner;
  x.plugins.runner = async (command, args, options) =>
    args.includes("marketplace")
      ? JSON.stringify({
          marketplaces: [
            {
              name: remote,
              marketplaceSource: { source: "example/renamed", sourceType: "git" },
            },
          ],
        })
      : original(command, args, options);
  const value = await x.list();
  const market = value.marketplaces.find(({ name }) => name === remote);
  assert.equal(market.builtin, true);
  assert.equal(market.removable, false);
  assert.equal(market.updatable, false);
});

test("a failing default remote read still lists configured shared marketplaces", async (t) => {
  const x = await fixture(t);
  const original = x.plugins.runner;
  x.plugins.runner = async (command, args, options) => {
    if (args[1] === "list" && !args.includes("--marketplace"))
      throw Object.assign(Error("Remote read failed"), { status: 502 });
    if (args.includes(remote))
      throw Object.assign(Error("Remote read failed"), { status: 502 });
    return original(command, args, options);
  };
  const value = await x.list();
  assert.equal(value.available, true);
  assert.equal(value.installed[0].id, "shared@local");
  assert.equal(value.catalog[0].id, "local-new@local");
  assert.ok(value.catalogReason);
  assert.ok(
    x.calls.some(({ args }) => args.includes("--marketplace") && args.at(-1) === "local"),
  );
});

test("remote mutations keep CLI-wide ownership and do not import account plugin state", async (t) => {
  const x = await fixture(t);
  const canonical = path.join(x.f.home, ".codex", "config.toml");
  const other = path.join(x.accounts.profile(x.b.id), "codex", "config.toml");
  const sharedBefore = await fs.readFile(canonical, "utf8").catch(() => "");
  const otherBefore = await fs.readFile(other, "utf8").catch(() => "");
  await fs.appendFile(
    path.join(x.accounts.profile(x.a.id), "codex", "config.toml"),
    '\n[plugins."private-cloud-state@openai-curated-remote"]\nenabled=true\n',
  );
  let release, entered;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const original = x.plugins.runner;
  x.plugins.runner = async (command, args, options) => {
    if (args[1] === "add") {
      entered();
      await hold;
    }
    return original(command, args, options);
  };
  const pending = x.plugins.mutate("local-codex", {
    action: "install",
    pluginId: `remote-new@${remote}`,
    catalogAccountId: x.a.id,
  });
  await started;
  try {
    await assert.rejects(
      x.plugins.mutate("local-codex", {
        action: "install",
        pluginId: `remote-new@${remote}`,
        catalogAccountId: x.b.id,
      }),
      { status: 409 },
    );
    const busy = await x.list(x.b.id);
    assert.equal(busy.busy, true);
    assert.equal(busy.catalogAccountId, x.b.id);
    assert.ok(!busy.installed.some(({ id }) => id === `a-installed@${remote}`));
    assert.equal(
      (await x.f.request(`/api/accounts/${x.a.id}`, { method: "DELETE" })).status,
      409,
    );
  } finally {
    release();
  }
  await pending;
  assert.equal(await fs.readFile(canonical, "utf8").catch(() => ""), sharedBefore);
  assert.equal(await fs.readFile(other, "utf8").catch(() => ""), otherBefore);
});

test("simultaneous selected catalogs have independent native reads", async (t) => {
  const x = await fixture(t);
  let release;
  x.state.hold = new Promise((resolve) => {
    release = resolve;
  });
  const a = x.plugins.list("local-codex", x.a.id);
  const b = x.plugins.list("local-codex", x.b.id);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(x.calls.some(({ accountId }) => accountId === x.a.id));
    assert.ok(x.calls.some(({ accountId }) => accountId === x.b.id));
  } finally {
    release();
  }
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.catalogAccountId, x.a.id);
  assert.equal(second.catalogAccountId, x.b.id);
  assert.equal(
    first.catalog.find(({ id }) => id === `a-installed@${remote}`).installed,
    true,
  );
  assert.equal(
    second.catalog.find(({ id }) => id === `a-installed@${remote}`).installed,
    false,
  );
});
