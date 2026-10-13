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
    path.join(f.project, "report.html"),
    "<script>window.bad=true</script>",
  );
  const artifact = await f.application.artifacts.publish(
    { sessionId: issued.session.id, projectId: project.id, cwd: f.project },
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
test("artifact list route validates search and pin filters and searches session and project names", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f, { choices: true });
  const project = f.application.memory.projects().projects[0];
  await fs.writeFile(path.join(f.project, "report.html"), "<h1>Report</h1>");
  const publish = (title) =>
    f.application.artifacts.publish(
      { sessionId: issued.session.id, projectId: project.id, cwd: f.project },
      { requestId: randomUUID(), title, sourcePath: "report.html" },
      async () => {},
    );
  const report = await publish("Quarterly report");
  const chart = await publish("Latency chart");
  assert.equal(
    (
      await f.request(`/api/artifacts/${chart.id}`, {
        method: "PATCH",
        body: { pinned: true },
      })
    ).status,
    200,
  );
  const list = async (query) => {
    const response = await f.request(`/api/artifacts?${query}`);
    assert.equal(response.status, 200, query);
    return response.json();
  };
  assert.equal((await fetch(`${f.url}/api/artifacts?q=report`)).status, 401);
  const all = await list("");
  assert.deepEqual(all.counts, { all: 2, pinned: 1 });
  const pinned = await list("pinned=true");
  assert.deepEqual(
    pinned.items.map((item) => item.id),
    [chart.id],
  );
  assert.equal((await list("pinned=false")).total, 2);
  assert.deepEqual(
    (await list("q=QUARTERLY")).items.map((item) => item.id),
    [report.id],
  );
  // The session's name and the project's name find all of their artifacts, from stored
  // metadata: search never lists sessions through tmux.
  const sessionList = f.application.sessions.list;
  f.application.sessions.list = () => {
    throw new Error("search must not list sessions through tmux");
  };
  t.after(() => {
    f.application.sessions.list = sessionList;
  });
  assert.equal((await list(`q=${encodeURIComponent("disposable mcp")}`)).total, 2);
  assert.equal((await list(`q=${encodeURIComponent(project.name)}`)).total, 2);
  assert.equal((await list("q=no-such-artifact")).total, 0);
  for (const query of [
    `q=${"x".repeat(201)}`,
    "q=a%0Ab",
    "q=a&q=b",
    "pinned=yes",
    "pinned=true&pinned=true",
  ])
    assert.equal((await f.request(`/api/artifacts?${query}`)).status, 400, query);
});

test("searching artifacts shares one owner budget while plain lists stay unlimited", async (t) => {
  const f = await applicationFixture(t);
  for (let index = 0; index < 120; index++)
    assert.equal((await f.request("/api/artifacts?q=report")).status, 200, String(index));
  const limited = await f.request("/api/artifacts?q=report");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "ARTIFACT_RATE_LIMITED");
  assert.equal((await f.request("/api/artifacts")).status, 200);
  assert.equal((await f.request("/api/artifacts?pinned=true")).status, 200);
});
