import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Preferences } from "../../server/features/settings/preferences.js";
import { applicationFixture, fixtureFetch as fetch } from "../helpers/application.js";
function directory(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-preferences-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("default directory persists independently of service configuration and resolves symlinks", async (t) => {
  const dir = directory(t),
    home = path.join(dir, "home"),
    target = path.join(dir, "work");
  fs.mkdirSync(home);
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(home, "project"));
  fs.writeFileSync(path.join(dir, "config.json"), '{"port":9911}');
  const prefs = new Preferences({ dataDir: dir, home });
  assert.deepEqual(prefs.get(), { defaultCwd: home, defaultAccountIds: {} });
  await prefs.update({ defaultCwd: "~/project" });
  assert.deepEqual(new Preferences({ dataDir: dir, home }).get(), {
    defaultCwd: target,
    defaultAccountIds: {},
  });
  assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), '{"port":9911}');
  assert.equal(fs.statSync(path.join(dir, "preferences.json")).mode & 0o777, 0o600);
  for (const defaultCwd of [
    "",
    null,
    4,
    "relative",
    "/missing-agentpier-preferences",
    target + "\0bad",
  ])
    await assert.rejects(() => prefs.update({ defaultCwd }));
  assert.deepEqual(prefs.get(), { defaultCwd: target, defaultAccountIds: {} });
});
test("preference API requires same-origin mutation and new work launches use explicit/default directory precedence", async (t) => {
  const { root: dir, application: app, url } = await applicationFixture(t);
  const work = path.join(dir, "work"),
    explicit = path.join(dir, "explicit");
  for (const p of [work, explicit]) fs.mkdirSync(p);
  app.sessions.list = async () => [];
  const launches = [];
  app.sessions.create = async (options) => {
    launches.push(options);
    return { ...options, status: "running" };
  };
  app.accounts.command = () => ({ command: process.execPath, args: [], env: {} });
  app.agentbus.prepare = async ({ launch }) => launch;
  const patch = (headers) =>
    fetch(url + "/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ defaultCwd: work }),
    });
  assert.equal((await patch({})).status, 403);
  assert.equal((await patch({ origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await patch({ origin: url })).status, 200);
  assert.equal((await (await fetch(url + "/api/state")).json()).defaultCwd, work);
  assert.deepEqual(await (await fetch(url + "/api/preferences")).json(), {
    defaultCwd: work,
    defaultAccountIds: {},
  });
  for (const body of [
    { accountId: "local-codex" },
    { accountId: "local-codex", cwd: explicit },
  ])
    assert.equal(
      (
        await fetch(url + "/api/sessions", {
          method: "POST",
          headers: { origin: url, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      201,
    );
  assert.deepEqual(
    launches.map((s) => s.cwd),
    [work, explicit],
  );
});
