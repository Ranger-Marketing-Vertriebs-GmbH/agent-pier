import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { freePortRange } from "../helpers/preview-ports.js";
import { startUpstream } from "../helpers/preview-proxy-fixture.js";
import { liveGate } from "../../server/application/live-wiring.js";
import { previewsTopic } from "../../server/features/previews/live-topics.js";
import { userMayWatch } from "../../server/http/route-access.js";

async function previewApp(t) {
  const range = await freePortRange(3);
  const f = await applicationFixture(t, {
    prepareDataDir: async (dataDir) => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          previews: {
            enabled: true,
            portRangeStart: range.start,
            portRangeEnd: range.end,
          },
        }),
      );
    },
  });
  f.application.previews.sessionAlive = () => true;
  await f.application.previews.start();
  return f;
}

test("GET /api/previews lists and DELETE stops a preview as the owner", async (t) => {
  const f = await previewApp(t);
  const upstream = await startUpstream(t);
  const owner = { kind: "session", sessionId: "s1", project: f.project };
  const opened = await f.application.previews.open({
    owner,
    port: upstream.port,
    label: "Shop",
  });
  assert.equal((await fetch(f.url + "/api/previews")).status, 401);
  const listed = await (await f.request("/api/previews")).json();
  assert.equal(listed.previews.length, 1);
  assert.equal(listed.previews[0].id, opened.id);
  assert.deepEqual(listed.previews[0].owner, { kind: "session", sessionId: "s1" });
  assert.equal(listed.slots.length, 3);
  assert.equal(JSON.stringify(listed).includes(f.project), false);
  assert.equal(
    (await f.request(`/api/previews/${opened.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.deepEqual((await (await f.request("/api/previews")).json()).previews, []);
  const [stopped] = f.application.audit.list({ action: "preview.stopped" }).events;
  assert.equal(stopped.source, "user");
  assert.equal(stopped.details.reason, "owner");
  const missing = await f.request(`/api/previews/${opened.id}`, { method: "DELETE" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "PREVIEW_NOT_FOUND");
});

test("the previews topic and routes are owner only", async (t) => {
  const f = await previewApp(t);
  const topic = previewsTopic(f.application);
  assert.equal(topic.authorize({ role: "owner" }), true);
  assert.equal(topic.authorize({ role: "user" }), false);
  assert.equal(topic.authorize(null), false);
  assert.equal(liveGate({ role: "user" }, "previews"), false);
  assert.equal(userMayWatch("previews"), false);
  assert.deepEqual((await topic.read()).previews, []);
});
