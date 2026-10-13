import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

test("the settings summary reads local state and needs a login", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await fetch(`${f.url}/api/settings/summary`)).status, 401);
  const first = await f.request("/api/settings/summary");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const summary = await first.json();
  assert.deepEqual(summary.access.ssh, { count: 0 });
  assert.deepEqual(summary.access.github, { count: 0 });
  assert.deepEqual(summary.access.remote, {
    tailscale: false,
    network: false,
    restartRequired: false,
  });
  assert.equal(typeof summary.access.mcp.activeGrants, "number");
  assert.equal(summary.operations.diagnostics, null);
  assert.deepEqual(summary.operations.backups, { count: 0, lastAt: null });
  assert.equal(summary.operations.updates.checked, false);
  assert.equal(summary.operations.updates.available, null);
  assert.equal(typeof summary.operations.updates.current, "string");

  // A cached update check with a newer version shows as available.
  const releases = f.application.operations.releases;
  fs.writeFileSync(
    path.join(releases.directory, "candidate.json"),
    JSON.stringify({ version: "999.0.0", upToDate: false }),
  );
  const checked = await (await f.request("/api/settings/summary")).json();
  assert.deepEqual(checked.operations.updates, {
    current: summary.operations.updates.current,
    checked: true,
    available: "999.0.0",
  });
});

test("a saved but not yet applied network change reads as restart required", async (t) => {
  const f = await applicationFixture(t);
  const remote = await (await f.request("/api/remote")).json();
  const saved = await f.request("/api/remote", {
    method: "PUT",
    body: {
      network: { ...remote.network.saved, enabled: !remote.network.saved.enabled },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).network.restartRequired, true);
  const summary = await (await f.request("/api/settings/summary")).json();
  assert.equal(summary.access.remote.network, Boolean(remote.network.running?.enabled));
  assert.equal(summary.access.remote.restartRequired, true);
});
