import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserNetworkSettings } from "../../server/features/assistants/browser-network-settings.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";
import {
  webToolsSections,
  webToolsSnapshot,
} from "../../server/features/assistants/openclaw-config/web-tools.js";

function settings(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-network-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new BrowserNetworkSettings({ dataDir });
}

test("browser network settings default off, validate and persist with revision checks", (t) => {
  const store = settings(t);
  assert.deepEqual(store.get(), { revision: 0, allowPrivateNetwork: false });
  for (const input of [
    null,
    [],
    {},
    { revision: 0, allowPrivateNetwork: "true" },
    { revision: 0, allowPrivateNetwork: true, hosts: ["*"] },
    { revision: -1, allowPrivateNetwork: true },
  ])
    assert.throws(() => store.save(input), { status: 400 });
  store.save({ revision: 0, allowPrivateNetwork: true });
  assert.throws(() => store.save({ revision: 0, allowPrivateNetwork: false }), {
    status: 409,
  });
  assert.equal(
    new BrowserNetworkSettings({ dataDir: path.dirname(path.dirname(store.file)) }).get()
      .allowPrivateNetwork,
    true,
  );
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.deepEqual(store.save({ revision: 1, allowPrivateNetwork: false }), {
    revision: 2,
    allowPrivateNetwork: false,
  });
});

test("global browser permission changes only browser policy and its restart signature", () => {
  const webTools = { browser: { available: true, executablePath: "/fixture/chrome" } };
  const compile = (enabled) =>
    webToolsSections({
      profiles: [],
      port: 20000,
      webTools: { ...webTools, browserAllowPrivateNetwork: enabled },
    });
  const off = compile(false),
    on = compile(true);
  assert.equal(off.browser.ssrfPolicy, undefined);
  assert.deepEqual(on.browser.ssrfPolicy, { dangerouslyAllowPrivateNetwork: true });
  assert.equal(on.browser.noSandbox, undefined);
  assert.deepEqual(on.browser.profiles, off.browser.profiles);
  assert.deepEqual(on.web, off.web);
  assert.equal(on.web.fetch.ssrfPolicy.dangerouslyAllowPrivateNetwork, false);
  assert.equal(compile("true").browser.ssrfPolicy, undefined);
  const snapshot = (enabled) =>
    webToolsSnapshot({
      profiles: [],
      webTools: { ...webTools, browserAllowPrivateNetwork: enabled },
    });
  const before = snapshot(false),
    after = snapshot(true);
  assert.equal(after.browserAllowPrivateNetwork, true);
  assert.notEqual(before.signatures.browser, after.signatures.browser);
  for (const key of Object.keys(before.signatures).filter((key) => key !== "browser"))
    assert.equal(before.signatures[key], after.signatures[key]);
});

test("saving and revoking remain pending until the running policy changes, with audit", async (t) => {
  const browserNetwork = settings(t);
  const events = [],
    restarts = [];
  const runtime = {
    client: { ready: true },
    webTools: { browserAllowPrivateNetwork: false },
  };
  const service = new WebToolsChanges({
    assistants: { runtime, store: { listAssistants: () => [] } },
    browserNetwork,
    synchronization: { pending: { request: (...args) => restarts.push(args) } },
    audit: { append: (event) => events.push(event) },
  });
  assert.deepEqual(
    await service.saveBrowserNetwork({ revision: 0, allowPrivateNetwork: true }),
    { revision: 1, allowPrivateNetwork: true, active: false },
  );
  runtime.webTools.browserAllowPrivateNetwork = true;
  assert.deepEqual(
    await service.saveBrowserNetwork({ revision: 1, allowPrivateNetwork: false }),
    { revision: 2, allowPrivateNetwork: false, active: true },
  );
  assert.equal(restarts.length, 2);
  assert.deepEqual(
    events.map((event) => event.action),
    ["setting.activated", "setting.revoked"],
  );
  runtime.client.ready = false;
  assert.equal(service.networkStatus().active, null);
  await service.saveBrowserNetwork({ revision: 2, allowPrivateNetwork: true });
  assert.equal(
    restarts.length,
    3,
    "a starting or reconnecting runtime also queues a restart",
  );
});
