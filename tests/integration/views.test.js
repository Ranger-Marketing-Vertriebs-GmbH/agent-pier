import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";

const call = (f, route, method, body) =>
  f.request(`/api/views${route}`, { method, ...(body ? { body } : {}) });
const s1 = { kind: "session", id: "s1" },
  c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };
const layout = {
  type: "split",
  dir: "row",
  ratio: 0.4,
  a: { type: "pane", item: s1, tab: "terminal" },
  b: { type: "pane", item: c1 },
};

test("views: create, rename, set layout, use and delete through /api/views", async (t) => {
  const f = await applicationFixture(t);
  assert.deepEqual(await (await call(f, "", "GET")).json(), { version: 0, views: [] });

  const created = await call(f, "", "POST", { name: "Shop", layout: null });
  assert.equal(created.status, 201);
  const { version, view } = await created.json();
  assert.equal(version, 1);
  assert.equal(view.revision, 1);

  let answer = await (await call(f, `/${view.id}`, "PATCH", { name: "B" })).json();
  assert.equal(answer.version, 2);
  assert.equal(answer.view.revision, 2);
  assert.equal(answer.view.name, "B");

  answer = await (await call(f, `/${view.id}`, "PATCH", { layout })).json();
  assert.deepEqual(answer.view.layout, layout);

  await new Promise((resolve) => setTimeout(resolve, 5));
  answer = await (await call(f, `/${view.id}`, "PATCH", { used: true })).json();
  assert.equal(answer.version, 4);
  assert.notEqual(answer.view.usedAt, view.usedAt);

  assert.deepEqual(await (await call(f, `/${view.id}`, "DELETE")).json(), {
    version: 5,
  });
  assert.deepEqual(await (await call(f, "", "GET")).json(), { version: 5, views: [] });
});

test("views: refusals carry code and messageKey", async (t) => {
  const f = await applicationFixture(t);
  const refused = await call(f, "", "POST", { name: "", layout: null });
  assert.equal(refused.status, 400);
  const body = await refused.json();
  assert.equal(body.code, "VIEW_NAME_INVALID");
  assert.equal(typeof body.messageKey, "string");
  const unknown = await call(f, "/v_0000000000000000", "PATCH", { name: "B" });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "VIEW_UNKNOWN");
});

test("views: a write pushes the views topic", async (t) => {
  const f = await applicationFixture(t);
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "views" });
  const first = await live.next((frame) => frame.topic === "views", 5000);
  assert.deepEqual(first.data, { version: 0, views: [] });
  const pushed = live.next(
    (frame) => frame.topic === "views" && frame.data?.version === 1,
  );
  assert.equal((await call(f, "", "POST", { name: "A", layout: null })).status, 201);
  assert.equal((await pushed).data.views.length, 1);
  live.ws.close();
});

test("views: writes do not signal settings.summary", async (t) => {
  const f = await applicationFixture(t);
  const { view } = await (await call(f, "", "POST", { name: "A", layout: null })).json();
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "settings.summary" });
  await live.next((frame) => frame.topic === "settings.summary", 5000);
  const changed = live.next(
    (frame) => frame.topic === "settings.summary" && frame.type === "changed",
    500,
  );
  changed.catch(() => {});
  assert.equal((await call(f, `/${view.id}`, "PATCH", { name: "B" })).status, 200);
  await assert.rejects(changed, /no matching frame/);
  live.ws.close();
});

test("views: a backup contains views.json and a restore brings it back as saved", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "restore-views-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  await fs.mkdir(source);
  const document = {
    version: 3,
    views: [
      {
        id: "v_0123456789abcdef",
        name: "Shop",
        layout,
        revision: 2,
        createdAt: "2026-11-01T10:00:00.000Z",
        usedAt: "2026-11-01T11:00:00.000Z",
      },
    ],
  };
  await fs.writeFile(path.join(source, "views.json"), JSON.stringify(document));
  const backups = new Backup({ dataDir: source, home: root });
  assert.ok(backups.plan({}).components.includes("views"));
  const backup = await backups.create();
  await new Restore({ dataDir: source }).apply({
    archive: backup.file,
    targetDataDir: target,
  });
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(target, "views.json"), "utf8")),
    document,
  );
});
