import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { freePortRange } from "../helpers/preview-ports.js";
import { send, startUpstream } from "../helpers/preview-proxy-fixture.js";
import { portAvailable } from "../../server/features/pipelines/run-ports.js";

async function app(t, previews) {
  const f = await applicationFixture(t, {
    prepareDataDir: async (dataDir) => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify(previews ? { previews } : {}),
      );
    },
  });
  f.application.previews.sessionAlive = () => true;
  return f;
}
const settings = (range, enabled = true) => ({
  enabled,
  portRangeStart: range.start,
  portRangeEnd: range.end,
});
const ports = (range) =>
  Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i);
const listening = async (range) =>
  (await Promise.all(ports(range).map((port) => portAvailable(port)))).map(
    (free) => !free,
  );
const idle = (f, port) =>
  send(port, { path: "/", headers: { host: `127.0.0.1:${port}`, cookie: f.cookie } });
const owner = (f) => ({ kind: "session", sessionId: "s1", project: f.project });

test("switching previews on at runtime binds every slot", async (t) => {
  const range = await freePortRange(3);
  const f = await app(t);
  const { previews } = f.application;
  assert.deepEqual(await listening(range), [false, false, false]);
  const view = await previews.configure(settings(range), { source: "user" });
  assert.deepEqual(await listening(range), [true, true, true]);
  assert.deepEqual(
    view.slots.map((slot) => slot.state),
    ["free", "free", "free"],
  );
  assert.equal((await idle(f, range.start)).status, 404);
});

test("switching previews off closes previews and frees every slot port", async (t) => {
  const range = await freePortRange(3);
  const upstream = await startUpstream(t);
  const f = await app(t, settings(range));
  const { previews } = f.application;
  await previews.start();
  await previews.open({ owner: owner(f), port: upstream.port });
  const view = await previews.configure(settings(range, false), { source: "user" });
  assert.deepEqual(view.previews, []);
  assert.deepEqual(await listening(range), [false, false, false]);
  const rows = f.application.audit.list({ action: "preview.stopped" }).events;
  assert.equal(rows[0].details.reason, "disabled");
  await assert.rejects(previews.open({ owner: owner(f), port: upstream.port }), {
    code: "PREVIEW_DISABLED",
  });
  // Switched on again, the slots serve again.
  await previews.configure(settings(range), { source: "user" });
  assert.deepEqual(await listening(range), [true, true, true]);
});

test("a range change closes previews outside the new range and moves the listeners", async (t) => {
  const range = await freePortRange(6);
  const upstream = await startUpstream(t);
  const old = { start: range.start, end: range.start + 2 };
  const next = { start: range.start + 3, end: range.end };
  const f = await app(t, settings(old));
  const { previews } = f.application;
  await previews.start();
  await previews.open({ owner: owner(f), port: upstream.port });
  const view = await previews.configure(settings(next), { source: "user" });
  assert.deepEqual(view.previews, []);
  assert.deepEqual(await listening(old), [false, false, false]);
  assert.deepEqual(await listening(next), [true, true, true]);
  assert.equal((await idle(f, next.start)).status, 404);
  const rows = f.application.audit.list({ action: "preview.stopped" }).events;
  assert.equal(rows[0].details.reason, "range");
  // The new range allocates again.
  const opened = await previews.open({ owner: owner(f), port: upstream.port });
  assert.match(opened.url, new RegExp(`:(${ports(next).join("|")})/`));
});

test("a range change keeps previews whose slot stays inside", async (t) => {
  const range = await freePortRange(6);
  const upstream = await startUpstream(t);
  const old = { start: range.start, end: range.start + 3 };
  const f = await app(t, settings(old));
  const { previews } = f.application;
  await previews.start();
  await previews.open({ owner: owner(f), port: upstream.port });
  const [{ slot }] = previews.list();
  const next = { start: slot, end: range.end };
  const view = await previews.configure(settings(next), { source: "user" });
  assert.equal(view.previews.length, 1);
  assert.equal(view.slots.find((entry) => entry.port === slot).state, "preview");
  assert.equal(await portAvailable(slot), false);
});

test("configure refuses an invalid range and writes nothing", async (t) => {
  const f = await app(t);
  await assert.rejects(
    f.application.previews.configure(
      { enabled: true, portRangeStart: 40000, portRangeEnd: 40100 },
      { source: "user" },
    ),
    { code: "PREVIEW_RANGE_INVALID", status: 400 },
  );
  assert.equal(f.application.previews.settings().enabled, false);
});
