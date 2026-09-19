import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { issue } from "../helpers/session-mcp.js";
test("artifact owner routes require login, return inert bundles and preserve pins after session deletion", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f, { choices: true });
  const project = f.application.memory.projects().projects[0];
  await fs.writeFile(
    path.join(f.home, "report.html"),
    "<script>window.bad=true</script>",
  );
  const artifact = await f.application.artifacts.publish(
    { sessionId: issued.session.id, projectId: project.id, cwd: f.home },
    { requestId: randomUUID(), title: "Report", sourcePath: "report.html" },
    async () => {},
  );
  const route = `/api/artifacts/${artifact.id}`;
  const denied = await fetch(f.url + route + "/bundle");
  assert.equal(denied.status, 401);
  const response = await f.request(route + "/bundle");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await response.json()).files.length, 1);
  assert.equal(
    (
      await f.request(route, {
        method: "PATCH",
        body: { pinned: true },
        origin: "https://foreign.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request(route, { method: "PATCH", body: { pinned: true } })).status,
    200,
  );
  await f.application.sessions.stop(issued.session.id);
  await f.application.sessions.remove(issued.session.id);
  const listing = await (
    await f.request(`/api/artifacts?projectId=${project.id}`)
  ).json();
  assert.equal(listing.items[0].orphaned, true);
  assert.equal((await f.request(route, { method: "DELETE" })).status, 204);
  assert.equal((await f.request(route + "/bundle")).status, 404);
  assert.equal((await f.request("/api/artifacts?sessionId=../invalid")).status, 400);
});
