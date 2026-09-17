import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, fixtureFetch } from "../helpers/application.js";

test("private SSH downloads require owner login and origin and never enter key metadata", async (t) => {
  const f = await applicationFixture(t);
  const created = await fixtureFetch(`${f.url}/api/ssh-keys`, {
    method: "POST",
    headers: { origin: f.url, "content-type": "application/json" },
    body: JSON.stringify({ name: "Disposable" }),
  });
  assert.equal(created.status, 201);
  const key = await created.json();
  const url = `${f.url}/api/ssh-keys/${key.id}/download`;
  const downloaded = await fixtureFetch(url, {
    method: "POST",
    headers: { origin: f.url },
  });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("cache-control"), "no-store");
  assert.match(downloaded.headers.get("content-disposition"), /attachment;.*\.key/);
  assert.match(await downloaded.text(), /BEGIN OPENSSH PRIVATE KEY/);
  const listed = await (await fixtureFetch(`${f.url}/api/ssh-keys`)).json();
  assert.equal(JSON.stringify(listed).includes("PRIVATE KEY"), false);
  assert.equal(
    (await fetch(url, { method: "POST", headers: { origin: f.url } })).status,
    401,
  );
  assert.equal(
    (
      await fixtureFetch(url, {
        method: "POST",
        headers: { origin: "https://outside.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await fixtureFetch(url, { method: "POST" })).status, 403);
  assert.equal(
    (
      await fixtureFetch(url, {
        method: "POST",
        headers: { origin: f.url, authorization: "Bearer machine" },
      })
    ).status,
    403,
  );
  assert.notEqual((await fixtureFetch(url)).status, 200);
});

test("real session persistence inherits project hosts without explicit grants", async (t) => {
  const f = await applicationFixture(t);
  const projectResponse = await f.request("/api/memory/projects", {
    method: "POST",
    body: { cwd: f.home },
  });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();
  const key = await (
    await f.request("/api/ssh-keys", {
      method: "POST",
      body: { name: "Project key", projectId: project.id },
    })
  ).json();
  const hostResponse = await f.request("/api/ssh-accesses", {
    method: "POST",
    body: {
      name: "Project host",
      host: "fixture.invalid",
      username: "deploy",
      keyId: key.id,
      hostKey: key.publicKey,
      projectId: project.id,
    },
  });
  assert.equal(hostResponse.status, 201);
  const host = await hostResponse.json();
  const start = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-shell", cwd: f.home },
  });
  assert.equal(start.status, 201);
  const session = await start.json();
  const state = await (
    await f.request(`/api/sessions/${session.id}/ssh-accesses`)
  ).json();
  assert.deepEqual(state.assignedIds, []);
  assert.deepEqual(state.inheritedIds, [host.id]);
  await f.restart();
  const restarted = await (
    await f.request(`/api/sessions/${session.id}/ssh-accesses`)
  ).json();
  assert.deepEqual(restarted.inheritedIds, [host.id]);
});

test("project collision HTTP responses contain only bounded public conflicting IDs", async (t) => {
  const f = await applicationFixture(t);
  const projects = [];
  for (const cwd of [f.home, f.dataDir]) {
    const response = await f.request("/api/memory/projects", {
      method: "POST",
      body: { cwd },
    });
    assert.equal(response.status, 201);
    projects.push(await response.json());
  }
  const hosts = [];
  for (const project of projects) {
    const key = await (
      await f.request("/api/ssh-keys", {
        method: "POST",
        body: { name: "Key", projectId: project.id },
      })
    ).json();
    const response = await f.request("/api/ssh-accesses", {
      method: "POST",
      body: {
        name: "Host",
        projectId: project.id,
        keyId: key.id,
        hostKey: key.publicKey,
        host: "fixture.invalid",
        username: "deploy",
      },
    });
    assert.equal(response.status, 201);
    hosts.push(await response.json());
  }
  const response = await f.request("/api/ssh-projects/reassign", {
    method: "POST",
    body: {
      fromProjectId: projects[0].id,
      toProjectId: projects[1].id,
    },
  });
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.deepEqual(result, {
    code: "SSH_PROJECT_COLLISION",
    error: "The target project already contains a matching key or host.",
    details: { resourceIds: hosts.map((host) => host.id), truncated: false },
  });
});
